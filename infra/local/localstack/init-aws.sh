#!/bin/bash
# LocalStack "ready" hook: creates the private media bucket and the queues (each with a DLQ),
# mirroring the AWS setup in infra/. Queue settings come from infra/cdk.json so local and AWS
# don't drift. Idempotent: safe to run again against an existing LocalStack.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-southeast-1}"
STAGE="${SHOTX_LOCAL_STAGE:-local}"
BUCKET="${MEDIA_BUCKET:-shotx-${STAGE}-media}"
CDK_JSON="${SHOTX_CDK_JSON:-/etc/shotx/cdk.json}"
WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:3000}"

echo "shotx: creating bucket ${BUCKET}"
if ! awslocal s3api head-bucket --bucket "${BUCKET}" 2>/dev/null; then
  awslocal s3api create-bucket --bucket "${BUCKET}" \
    --create-bucket-configuration "LocationConstraint=${REGION}"
fi
# Never public, same as AWS.
awslocal s3api put-public-access-block --bucket "${BUCKET}" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awslocal s3api put-bucket-ownership-controls --bucket "${BUCKET}" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
awslocal s3api put-bucket-cors --bucket "${BUCKET}" --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedOrigins\": [\"${WEB_ORIGIN}\"],
    \"AllowedMethods\": [\"PUT\"],
    \"AllowedHeaders\": [\"*\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3000
  }]
}"

# Lifecycle rules (stored by LocalStack for parity; expiry isn't enforced locally).
python3 - "${CDK_JSON}" > /tmp/shotx-lifecycle.json <<'PY'
import json, sys
storage = json.load(open(sys.argv[1]))["context"]["shotx"]["storage"]
print(json.dumps({"Rules": [
    {"ID": "abort-incomplete-multipart-uploads", "Status": "Enabled", "Filter": {"Prefix": ""},
     "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": storage["abortIncompleteMultipartUploadDays"]}},
    {"ID": "expire-tmp", "Status": "Enabled", "Filter": {"Prefix": "tmp/"},
     "Expiration": {"Days": storage["tmpExpirationDays"]}},
    {"ID": "originals-intelligent-tiering", "Status": "Enabled", "Filter": {"Prefix": "originals/"},
     "Transitions": [{"Days": storage["originalsIntelligentTieringAfterDays"], "StorageClass": "INTELLIGENT_TIERING"}]},
]}))
PY
awslocal s3api put-bucket-lifecycle-configuration --bucket "${BUCKET}" \
  --lifecycle-configuration file:///tmp/shotx-lifecycle.json

# Queues: "<name> <visibility s> <retention s> <dlq retention s> <max receives>" per line.
python3 - "${CDK_JSON}" > /tmp/shotx-queues.txt <<'PY'
import json, sys
queues = json.load(open(sys.argv[1]))["context"]["shotx"]["queues"]
for name, q in queues.items():
    print(name, q["visibilityTimeoutSeconds"], q["retentionDays"] * 86400,
          q["dlqRetentionDays"] * 86400, q["maxReceiveCount"])
PY

MEDIA_QUEUE_ARN=""
while read -r name visibility retention dlq_retention max_receives; do
  queue="shotx-${STAGE}-${name}"
  echo "shotx: creating queue ${queue} (+ ${queue}-dlq)"
  dlq_url=$(awslocal sqs create-queue --queue-name "${queue}-dlq" \
    --attributes "MessageRetentionPeriod=${dlq_retention}" --query QueueUrl --output text)
  dlq_arn=$(awslocal sqs get-queue-attributes --queue-url "${dlq_url}" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)
  redrive="{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"${max_receives}\"}"
  attributes=$(python3 -c 'import json,sys; print(json.dumps({
    "VisibilityTimeout": sys.argv[1], "MessageRetentionPeriod": sys.argv[2],
    "ReceiveMessageWaitTimeSeconds": "20", "RedrivePolicy": sys.argv[3]}))' \
    "${visibility}" "${retention}" "${redrive}")
  queue_url=$(awslocal sqs create-queue --queue-name "${queue}" --attributes "${attributes}" \
    --query QueueUrl --output text)
  # create-queue keeps an existing queue's attributes; apply them again so reruns converge.
  awslocal sqs set-queue-attributes --queue-url "${queue_url}" --attributes "${attributes}"
  if [ "${name}" = "media" ]; then
    MEDIA_QUEUE_ARN=$(awslocal sqs get-queue-attributes --queue-url "${queue_url}" \
      --attribute-names QueueArn --query Attributes.QueueArn --output text)
  fi
done < /tmp/shotx-queues.txt

# Completed uploads under originals/ start the media pipeline, as on AWS.
awslocal s3api put-bucket-notification-configuration --bucket "${BUCKET}" \
  --notification-configuration "{
    \"QueueConfigurations\": [{
      \"QueueArn\": \"${MEDIA_QUEUE_ARN}\",
      \"Events\": [\"s3:ObjectCreated:*\"],
      \"Filter\": {\"Key\": {\"FilterRules\": [{\"Name\": \"prefix\", \"Value\": \"originals/\"}]}}
    }]
  }"

echo "shotx: LocalStack resources ready"
