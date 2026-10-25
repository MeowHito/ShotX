# ShotX infrastructure (AWS CDK)

Everything runs in `ap-southeast-1`, except what CloudFront requires in `us-east-1`.

| Stack                       | Region         | Contents                                                                                                                                                                                             |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ShotX-<stage>-Edge`        | us-east-1      | CloudFront-scoped WAF web ACLs (main, admin) with logging; ACM certificates for both domains                                                                                                         |
| `ShotX-<stage>-Network`     | ap-southeast-1 | VPC: public (NAT), app (ECS), data (RDS, Redis) subnets; S3 gateway endpoint; optional interface endpoints                                                                                           |
| `ShotX-<stage>-Registry`    | ap-southeast-1 | ECR repositories `shotx-<stage>/{web,admin,api,worker}` (immutable tags, scan on push)                                                                                                               |
| `ShotX-<stage>-Data`        | ap-southeast-1 | RDS PostgreSQL Multi-AZ (TLS forced); ElastiCache Redis Multi-AZ (TLS, encrypted)                                                                                                                    |
| `ShotX-<stage>-Auth`        | ap-southeast-1 | Cognito users pool (email, Google, LINE OIDC, optional TOTP) and admins pool (TOTP MFA required)                                                                                                     |
| `ShotX-<stage>-App`         | ap-southeast-1 | Private media bucket, CloudFront log bucket, SQS media/faces/zip/jobs (+ DLQs, alarms), ECS Fargate web/admin/api/worker, internal ALB, CloudFront main + admin distributions, EventBridge Scheduler |
| `ShotX-<stage>-PricingPlan` | us-east-1      | `AWS::PricingPlanManager::Subscription`: CloudFront flat-rate plan for the main distribution                                                                                                         |

Cross-stack references use `Fn::GetStackOutput` (CDK's recommended "weak" references), including
the cross-region ones. CDK still orders deployments by dependency.

## Commands

```sh
pnpm --filter @shotx/infra synth      # offline: no AWS credentials, no context lookups
pnpm --filter @shotx/infra test       # aws-cdk-lib/assertions invariants
```

Deployment is not automated yet. Never deploy from a laptop with placeholder values.

## Configuration

Every tunable is in the `shotx` object in `cdk.json` (validated by `lib/config.ts`). Fixed platform
facts (regions, path contracts, S3 prefixes, job types) are in `lib/constants.ts`.

Override any value from the CLI with `-c shotx:<dotted.path>=<value>`. JSON arrays and objects are
accepted:

```sh
cdk synth -c shotx:account=123456789012 -c shotx:services.imageTag=sha-abc123 \
  -c 'shotx:waf.adminAllowedIpv4Cidrs=["203.0.113.0/24"]'
```

Placeholders to replace before the first deploy: `account`, `domain.*`, `cdn.signingPublicKeyPem`,
`auth.google.clientId`, `auth.line.channelId`, `auth.domainPrefix`, `auth.adminDomainPrefix`,
`alarms.email`, and `network.cloudFrontOriginFacingPrefixListId` (verify it, see below).

## Environment variables the services get

| Variable                                                                                | web | admin | api | worker | Source                                      |
| --------------------------------------------------------------------------------------- | :-: | :---: | :-: | :----: | ------------------------------------------- |
| `NODE_ENV`, `APP_STAGE`, `AWS_REGION`, `PUBLIC_BASE_URL`, `ADMIN_BASE_URL`              |  x  |   x   |  x  |   x    | config                                      |
| `PORT`                                                                                  |  x  |   x   |  x  |        | `services.<name>.containerPort`             |
| `API_INTERNAL_URL`                                                                      |  x  |   x   |     |        | internal ALB                                |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSSLMODE=verify-full`, `PGUSER`, `PGPASSWORD`       |     |       |  x  |   x    | RDS; user/password from Secrets Manager     |
| `REDIS_URL` (`rediss://`)                                                               |     |       |  x  |   x    | ElastiCache                                 |
| `MEDIA_BUCKET`, `MEDIA_QUEUE_URL`, `FACES_QUEUE_URL`, `ZIP_QUEUE_URL`, `JOBS_QUEUE_URL` |     |       |  x  |   x    | App stack                                   |
| `CLOUDFRONT_MEDIA_BASE_URL`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY`         |     |       |  x  |        | key group; private key from Secrets Manager |
| `COGNITO_USER_POOL_ID`, `COGNITO_WEB_CLIENT_ID`, `COGNITO_DOMAIN`                       |  x  |       |  x  |        | Auth stack                                  |
| `COGNITO_ADMIN_USER_POOL_ID`, `COGNITO_ADMIN_CLIENT_ID`, `COGNITO_ADMIN_DOMAIN`         |     |   x   |  x  |        | Auth stack                                  |
| `FACE_*`, `NODE_EXTRA_CA_CERTS`                                                         |     |       |  x  |   x    | `services.env.backend`                      |

Extra variables go in `services.env.{common,backend,web,admin,api,worker}`.

## Routing

CloudFront reaches the internal ALB through a VPC origin; the ALB's security group admits only
the CloudFront origin-facing prefix list (and web/admin tasks calling the API).

| Distribution | Path              | Target                                                      |
| ------------ | ----------------- | ----------------------------------------------------------- |
| main         | `/api/*`          | api (no cache, all viewer headers/cookies/query forwarded)  |
| main         | `/media/*`        | S3 via OAC, signed URLs, `/media` stripped by a CF Function |
| main         | `/_next/static/*` | web (cached)                                                |
| main         | default           | web (no cache)                                              |
| admin        | `/api/*`          | api                                                         |
| admin        | `/_next/static/*` | admin (cached)                                              |
| admin        | default           | admin                                                       |

The ALB routes `/api` and `/api/*` to api, then on the `X-ShotX-App` header (`web`/`admin`) that
each distribution sets on its origin requests (CloudFront overwrites any viewer value). Anything
else gets a 404. The API therefore serves all routes under `/api` (for example
`POST /api/s/:token/face-search`), and health checks are `/healthz` (web, admin) and
`/api/health` (api).

## Before the first deploy

1. `cdk bootstrap aws://<account>/ap-southeast-1 aws://<account>/us-east-1`.
2. Secrets Manager (ap-southeast-1), names from `auth.*SecretName` and `secrets.*`:
   - Google OAuth client secret, LINE Login channel secret.
   - CloudFront signing private key. Generate the pair with
     `openssl genrsa -out key.pem 2048 && openssl rsa -pubout -in key.pem -out pub.pem`; put
     `pub.pem` in `cdn.signingPublicKeyPem` and the private key in the secret.
3. Verify the CloudFront origin-facing prefix list id in ap-southeast-1:
   `aws ec2 describe-managed-prefix-lists --region ap-southeast-1 --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing`.
   The list has ~55 entries and counts against the ALB security group's rule quota.
4. Deploy `Registry`, push the four images (ARM64 by default, `services.cpuArchitecture`), then
   deploy the rest with `-c shotx:services.imageTag=<tag>`.
5. LINE Developers console: add the Cognito callback
   `https://<auth.domainPrefix>.auth.ap-southeast-1.amazoncognito.com/oauth2/idpresponse` and
   apply for the email permission. Google Cloud console: the same callback URL.
6. Cognito sends email with its default sender (low daily limit). Configure SES before launch.

## After deploy

- **Flat-rate plan approval.** The `PricingPlan` stack creates a Business subscription in
  `PENDING_APPROVAL`; the distribution is billed pay-as-you-go until someone calls
  `ApprovePaidSubscription` (console, or the PricingPlanManager API in us-east-1) with the
  `SubscriptionArn` output. CloudFormation can't change the tier or usage level: do it in the
  console and then update `cdn.flatRatePlan.tier`. Deleting the stack schedules cancellation at the
  end of the billing period. Set `cdn.flatRatePlan.enabled=false` to manage the plan by hand.
- **WAF CAPTCHA for face search.** Create a CAPTCHA API key for the main domain (WAF console,
  application integration, us-east-1) and give the web app `WAF_CAPTCHA_API_KEY` and
  `WAF_CAPTCHA_SCRIPT_URL`. Without it, face-search calls challenged by the CAPTCHA rule fail
  instead of showing a puzzle.
- **DNS.** With a Route 53 zone (`domain.hostedZoneId`) records and certificate validation are
  automatic. Otherwise create the ACM validation CNAMEs and the CNAME/ALIAS records yourself.

## Before launch

- **Rekognition quotas.** Read each operation's TPS quota (IndexFaces, SearchFacesByImage,
  SearchFaces, DeleteFaces, collection operations) in Service Quotas for ap-southeast-1, request
  increases, and set `FACE_REKOGNITION_TPS_*` in `services.env.backend` to ~80% of each quota.
  Then load-test face search for the post-event spike. Keep `services.worker.maxCapacity` in line
  with the IndexFaces quota: extra workers only wait for rate-limit tokens.
- **faces queue visibility.** Must cover (1 + FACE_TILE_GRID²) × FACE_REKOGNITION_MAX_WAIT_MS
  plus processing; `lib/config.ts` rejects a shorter `queues.faces.visibilityTimeoutSeconds`.
- **Alarms.** Set `alarms.email` or subscribe the `AlarmTopicArn` topic to your paging tool.
- **WAF thresholds.** Venues share IPs (carrier NAT, venue Wi-Fi). Tune `waf.*RateLimit` with
  real traffic; the CAPTCHA tiers trigger before the block tiers.
