import {
  COGNITO_ENV,
  PAYMENT_GATEWAY_SECRET_ENV,
  QUEUE_NAMES,
  QUEUE_URL_ENV,
  QUEUE_VISIBILITY_TIMEOUT_ENV,
  type QueueName,
  S3_PREFIXES,
} from '@shotx/shared';
import { Annotations, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { faceSearchLimits, type PlatformConfig, workerSettings } from '../config';
import {
  ALB_SERVICES,
  APP_ROUTING_HEADER,
  PATHS,
  PRIMARY_REGION,
  type AlbServiceName,
  type ServiceName,
} from '../constants';
import { workerStopTimeoutSeconds } from '../worker-limits';
import type { JobQueue } from './job-queues';

export interface ServicesProps {
  readonly config: PlatformConfig;
  readonly vpc: ec2.IVpc;
  readonly repositories: Record<ServiceName, ecr.IRepository>;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly secret: secretsmanager.ISecret;
    readonly securityGroup: ec2.ISecurityGroup;
  };
  readonly redis: {
    readonly host: string;
    readonly port: number;
    /** JSON `{ username, password }` of the RBAC user. */
    readonly secret: secretsmanager.ISecret;
    readonly securityGroup: ec2.ISecurityGroup;
  };
  readonly cognito: {
    readonly userPoolId: string;
    readonly webClientId: string;
    readonly domain: string;
    readonly adminUserPoolId: string;
    readonly adminClientId: string;
    readonly adminDomain: string;
  };
  readonly bucket: s3.IBucket;
  readonly queues: Record<QueueName, JobQueue>;
  readonly cloudFrontKeyPairId: string;
}

/** Value of APP_ROUTING_HEADER that each distribution sets on its origin requests. */
export const ROUTING_HEADER_VALUES = { web: 'web', admin: 'admin' } as const;

/**
 * ECS Fargate services web, admin, api and worker, plus the internal ALB in front of the first
 * three. The ALB has no public address: CloudFront reaches it through a VPC origin, and its
 * security group only admits the CloudFront origin-facing prefix list (plus web/admin tasks
 * calling the API).
 *
 * ALB routing:
 *   /api, /api/*                -> api
 *   X-ShotX-App: admin          -> admin   (set by the admin distribution's origin)
 *   X-ShotX-App: web            -> web     (set by the main distribution's origin)
 *   anything else               -> 404
 */
export class Services extends Construct {
  readonly cluster: ecs.Cluster;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly services: Record<ServiceName, ecs.FargateService>;
  readonly taskRoles: Record<ServiceName, iam.IRole>;
  /** IP_HASH_SECRET (api): HMAC key of consents.ip_hash. */
  readonly ipHashSecret: secretsmanager.Secret;
  /**
   * The selected gateway's secrets (api and worker), one JSON key per
   * PAYMENT_GATEWAY_SECRET_ENV[billing.paymentGateway] name. Generated for `fake`; created by the
   * operator (billing.gatewaySecretName) for a real gateway.
   */
  readonly paymentGatewaySecret: secretsmanager.ISecret;
  readonly logGroups: Record<ServiceName, logs.LogGroup>;

  constructor(scope: Construct, id: string, props: ServicesProps) {
    super(scope, id);
    const { config, vpc, database, redis, cognito, bucket, queues } = props;
    const { services: svc, domain } = config;
    const prefix = `shotx-${config.stage}`;
    const appSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: prefix,
      containerInsightsV2: {
        enabled: ecs.ContainerInsights.ENABLED,
        enhanced: ecs.ContainerInsights.ENHANCED,
        disabled: ecs.ContainerInsights.DISABLED,
      }[svc.containerInsights],
    });

    // --- Load balancer -----------------------------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Internal ALB; reachable from CloudFront VPC origins only',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(
      ec2.Peer.prefixList(config.network.cloudFrontOriginFacingPrefixListId),
      ec2.Port.tcp(80),
      'CloudFront origin-facing (VPC origin)',
    );
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: appSubnets,
      securityGroup: albSg,
      idleTimeout: Duration.seconds(svc.albIdleTimeoutSeconds),
      dropInvalidHeaderFields: true,
      http2Enabled: true,
    });
    const listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not found',
      }),
    });
    const apiInternalUrl = `http://${this.loadBalancer.loadBalancerDnsName}`;

    // --- Environment -------------------------------------------------------------------------
    const mainUrl = `https://${domain.main}`;
    const adminUrl = `https://${domain.admin}`;
    const queueUrls = Object.fromEntries(
      QUEUE_NAMES.map((q) => [QUEUE_URL_ENV[q], queues[q].queue.queueUrl]),
    );
    const base: Record<string, string> = {
      NODE_ENV: 'production',
      APP_STAGE: config.stage,
      AWS_REGION: PRIMARY_REGION,
      PUBLIC_BASE_URL: mainUrl,
      ADMIN_BASE_URL: adminUrl,
    };
    const backend: Record<string, string> = {
      // node-postgres reads the standard libpq variables when DATABASE_URL is not set.
      PGHOST: database.host,
      PGPORT: String(database.port),
      PGDATABASE: database.name,
      PGSSLMODE: 'verify-full',
      // TLS, no credentials in the URL: clients pass REDIS_USERNAME and REDIS_PASSWORD (RBAC).
      REDIS_URL: `rediss://${redis.host}:${redis.port}`,
      MEDIA_BUCKET: bucket.bucketName,
      ...queueUrls,
    };
    const backendSecrets: Record<string, ecs.Secret> = {
      PGUSER: ecs.Secret.fromSecretsManager(database.secret, 'username'),
      PGPASSWORD: ecs.Secret.fromSecretsManager(database.secret, 'password'),
      REDIS_USERNAME: ecs.Secret.fromSecretsManager(redis.secret, 'username'),
      REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redis.secret, 'password'),
    };
    // Derived from the FACE_* configuration; set after the extra groups so they always match the
    // WAF rule and the faces queue.
    const faceSearch = faceSearchLimits(config);
    const apiDerived: Record<string, string> = {
      FACE_SEARCH_MAX_SELFIE_BYTES: String(faceSearch.selfieMaxBytes),
      FACE_SEARCH_MAX_BODY_BYTES: String(faceSearch.maxBodyBytes),
    };
    // The worker heartbeats every job with ChangeMessageVisibility every third of its queue's
    // timeout (README "Queue visibility and heartbeats"), so it needs each queue's timeout.
    const workerDerived = Object.fromEntries(
      QUEUE_NAMES.map((q) => [
        QUEUE_VISIBILITY_TIMEOUT_ENV[q],
        String(config.queues[q].visibilityTimeoutSeconds),
      ]),
    );
    const signingKey = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CloudFrontSigningKey',
      config.secrets.cloudFrontSigningPrivateKeyName,
    );
    const userPoolEnv = {
      [COGNITO_ENV.users.userPoolId]: cognito.userPoolId,
      [COGNITO_ENV.users.clientId]: cognito.webClientId,
      [COGNITO_ENV.users.domain]: cognito.domain,
    };
    const adminPoolEnv = {
      [COGNITO_ENV.admins.userPoolId]: cognito.adminUserPoolId,
      [COGNITO_ENV.admins.clientId]: cognito.adminClientId,
      [COGNITO_ENV.admins.domain]: cognito.adminDomain,
    };
    // HMAC key for consents.ip_hash. Generated, never in the template or in cdk.json. Retained:
    // a new key only means new rows can't be linked to old ones, but nothing needs that.
    this.ipHashSecret = new secretsmanager.Secret(this, 'IpHashSecret', {
      secretName: `${prefix}/ip-hash-secret`,
      description: 'IP_HASH_SECRET: HMAC-SHA256 key of consents.ip_hash (api)',
      removalPolicy: RemovalPolicy.RETAIN,
      generateSecretString: {
        passwordLength: config.secrets.ipHashSecretLength,
        excludePunctuation: true,
        includeSpace: false,
      },
    });
    // Payments and email (api and worker: the worker charges auto-renewals and sends reminders).
    const gateway = config.billing.paymentGateway;
    this.paymentGatewaySecret =
      gateway === 'fake'
        ? new secretsmanager.Secret(this, 'PaymentGatewaySecret', {
            secretName: `${prefix}/payment-gateway-fake`,
            description: 'PAYMENT_FAKE_WEBHOOK_SECRET: HMAC key of fake gateway webhooks',
            generateSecretString: {
              secretStringTemplate: '{}',
              generateStringKey: PAYMENT_GATEWAY_SECRET_ENV.fake[0],
              passwordLength: config.billing.fakeWebhookSecretLength,
              excludePunctuation: true,
              includeSpace: false,
            },
          })
        : secretsmanager.Secret.fromSecretNameV2(
            this,
            'PaymentGatewaySecret',
            config.billing.gatewaySecretName,
          );
    const paymentSecrets: Record<string, ecs.Secret> = Object.fromEntries(
      PAYMENT_GATEWAY_SECRET_ENV[gateway].map((name) => [
        name,
        ecs.Secret.fromSecretsManager(this.paymentGatewaySecret, name),
      ]),
    );
    const billing = {
      PAYMENT_GATEWAY: gateway,
      EMAIL_PROVIDER: config.email.provider,
      EMAIL_FROM_ADDRESS: config.email.fromAddress,
      EMAIL_FROM_NAME: config.email.fromName,
    };
    // Every ECS service runs with NODE_ENV=production, where the shared loaders refuse the fake
    // adapters (loadPaymentGatewayConfig, loadEmailConfig). Synth refuses them on the prod stage;
    // elsewhere it warns, because api and worker will not start.
    for (const [what, value] of [
      ['billing.paymentGateway', gateway],
      ['email.provider', config.email.provider],
    ] as const) {
      if (value === 'fake') {
        Annotations.of(this).addWarningV2(
          '@shotx/infra:fake-adapter',
          `${what} is fake: api and worker run with NODE_ENV=production, where the shared ` +
            `loaders refuse fake adapters, so they will fail to start on AWS`,
        );
      }
    }

    // Typed context values; services.env can't set these (config validation).
    // The AWS stacks keep Amazon Rekognition (ADR 0009: the self-hosted provider is the VPS's).
    const features = {
      FACE_SEARCH_ENABLED: String(config.features.faceSearchEnabled),
      FACE_PROVIDER: 'rekognition',
    };
    const consent = { CONSENT_POLICY_VERSION: config.consent.policyVersion };
    const extra = svc.env;

    const environment: Record<ServiceName, Record<string, string>> = {
      web: {
        ...base,
        ...userPoolEnv,
        PORT: String(svc.web.containerPort),
        API_INTERNAL_URL: apiInternalUrl,
        // CSP connect-src: the one bucket origin the browser PUTs upload parts to.
        MEDIA_BUCKET: bucket.bucketName,
        ...extra.common,
        ...extra.web,
      },
      admin: {
        ...base,
        ...adminPoolEnv,
        PORT: String(svc.admin.containerPort),
        API_INTERNAL_URL: apiInternalUrl,
        ...extra.common,
        ...extra.admin,
      },
      api: {
        ...base,
        ...backend,
        ...userPoolEnv,
        ...adminPoolEnv,
        PORT: String(svc.api.containerPort),
        CLOUDFRONT_MEDIA_BASE_URL: `${mainUrl}${PATHS.media}`,
        CLOUDFRONT_KEY_PAIR_ID: props.cloudFrontKeyPairId,
        ...extra.common,
        ...extra.backend,
        ...extra.api,
        ...apiDerived,
        ...features,
        ...consent,
        ...billing,
      },
      worker: {
        ...base,
        ...backend,
        ...extra.common,
        ...extra.backend,
        ...extra.worker,
        ...workerDerived,
        ...features,
        ...billing,
      },
    };
    const secrets: Record<ServiceName, Record<string, ecs.Secret>> = {
      web: {},
      admin: {},
      api: {
        ...backendSecrets,
        CLOUDFRONT_PRIVATE_KEY: ecs.Secret.fromSecretsManager(signingKey),
        IP_HASH_SECRET: ecs.Secret.fromSecretsManager(this.ipHashSecret),
        ...paymentSecrets,
      },
      worker: { ...backendSecrets, ...paymentSecrets },
    };

    // --- Services ----------------------------------------------------------------------------
    const services = {} as Record<ServiceName, ecs.FargateService>;
    const taskRoles = {} as Record<ServiceName, iam.IRole>;
    const securityGroups = {} as Record<ServiceName, ec2.SecurityGroup>;
    const logGroups = {} as Record<ServiceName, logs.LogGroup>;

    const createService = (
      name: ServiceName,
      sizing: { cpu: number; memoryMiB: number },
      port?: number,
    ) => {
      const taskDefinition = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        family: `${prefix}-${name}`,
        cpu: sizing.cpu,
        memoryLimitMiB: sizing.memoryMiB,
        ephemeralStorageGiB: name === 'worker' ? svc.worker.ephemeralStorageGiB : undefined,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.of(svc.cpuArchitecture),
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/shotx/${config.stage}/${name}`,
        retention: svc.logRetentionDays,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      logGroups[name] = logGroup;
      taskDefinition.addContainer(name, {
        image: ecs.ContainerImage.fromEcrRepository(props.repositories[name], svc.imageTag),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup }),
        environment: environment[name],
        secrets: secrets[name],
        portMappings: port === undefined ? [] : [{ containerPort: port, name: 'http' }],
        // The worker resets the visibility of unfinished messages after its shutdown grace.
        stopTimeout:
          name === 'worker'
            ? Duration.seconds(
                workerStopTimeoutSeconds(
                  workerSettings(config),
                  svc.worker.stopTimeoutMarginSeconds,
                ),
              )
            : undefined,
      });
      const securityGroup = new ec2.SecurityGroup(this, `${name}Sg`, {
        vpc,
        description: `${name} tasks`,
        allowAllOutbound: true,
      });
      const service = new ecs.FargateService(this, `${name}Service`, {
        cluster: this.cluster,
        serviceName: name,
        taskDefinition,
        vpcSubnets: appSubnets,
        securityGroups: [securityGroup],
        assignPublicIp: false,
        circuitBreaker: { enable: true, rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        enableExecuteCommand: false,
        healthCheckGracePeriod:
          port === undefined ? undefined : Duration.seconds(svc.healthCheckGracePeriodSeconds),
      });
      services[name] = service;
      taskRoles[name] = taskDefinition.taskRole;
      securityGroups[name] = securityGroup;
      return service;
    };

    const routing: Record<
      AlbServiceName,
      { priority: number; conditions: elbv2.ListenerCondition[] }
    > = {
      api: {
        priority: 10,
        conditions: [elbv2.ListenerCondition.pathPatterns([PATHS.api, `${PATHS.api}/*`])],
      },
      admin: {
        priority: 20,
        conditions: [
          elbv2.ListenerCondition.httpHeader(APP_ROUTING_HEADER, [ROUTING_HEADER_VALUES.admin]),
        ],
      },
      web: {
        priority: 30,
        conditions: [
          elbv2.ListenerCondition.httpHeader(APP_ROUTING_HEADER, [ROUTING_HEADER_VALUES.web]),
        ],
      },
    };

    for (const name of ALB_SERVICES) {
      const s = svc[name];
      const service = createService(name, s, s.containerPort);
      const targetGroup = new elbv2.ApplicationTargetGroup(this, `${name}Targets`, {
        vpc,
        port: s.containerPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(svc.targetDeregistrationDelaySeconds),
        healthCheck: { path: s.healthCheckPath, healthyHttpCodes: '200' },
      });
      new elbv2.ApplicationListenerRule(this, `${name}Rule`, {
        listener,
        priority: routing[name].priority,
        conditions: routing[name].conditions,
        targetGroups: [targetGroup],
      });
      service.attachToApplicationTargetGroup(targetGroup);
      service
        .autoScaleTaskCount({ minCapacity: s.minCapacity, maxCapacity: s.maxCapacity })
        .scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: s.cpuTargetUtilizationPercent });
    }

    // web and admin call the API server-side through the internal ALB.
    for (const name of ['web', 'admin'] as const) {
      albSg.addIngressRule(securityGroups[name], ec2.Port.tcp(80), `${name} tasks to API`);
    }

    // --- Worker: scales on total queue backlog -----------------------------------------------
    const worker = createService('worker', svc.worker);
    const scaling = svc.worker.queueDepthScaling;
    const period = Duration.seconds(scaling.periodSeconds);
    const usingMetrics: Record<string, cloudwatch.IMetric> = {};
    QUEUE_NAMES.forEach((q, i) => {
      usingMetrics[`v${i}`] = queues[q].queue.metricApproximateNumberOfMessagesVisible({ period });
      usingMetrics[`f${i}`] = queues[q].queue.metricApproximateNumberOfMessagesNotVisible({
        period,
      });
    });
    // FILL(.., 0): idle queues stop publishing metrics, and a missing series would otherwise
    // leave the scale-in alarm in INSUFFICIENT_DATA. An alarm takes at most 10 metrics, so this
    // works for up to 4 queues (8 series + the expression).
    const backlog = new cloudwatch.MathExpression({
      label: 'Messages visible + in flight (all worker queues)',
      expression: Object.keys(usingMetrics)
        .map((m) => `FILL(${m}, 0)`)
        .join(' + '),
      usingMetrics,
      period,
    });
    worker
      .autoScaleTaskCount({
        minCapacity: svc.worker.minCapacity,
        maxCapacity: svc.worker.maxCapacity,
      })
      .scaleOnMetric('QueueBacklog', {
        metric: backlog,
        adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: Duration.seconds(scaling.cooldownSeconds),
        scalingSteps: scaling.steps.map((s) => ({
          lower: s.lower,
          upper: s.upper,
          change: s.change,
        })),
      });

    // --- Network access to data stores ------------------------------------------------------
    // Rules live in this stack (the consumer) so the Data stack never depends on the App stack.
    for (const name of ['api', 'worker'] as const) {
      new ec2.CfnSecurityGroupIngress(this, `${name}ToPostgres`, {
        groupId: database.securityGroup.securityGroupId,
        sourceSecurityGroupId: securityGroups[name].securityGroupId,
        ipProtocol: 'tcp',
        fromPort: database.port,
        toPort: database.port,
        description: `${name} tasks to PostgreSQL`,
      });
      new ec2.CfnSecurityGroupIngress(this, `${name}ToRedis`, {
        groupId: redis.securityGroup.securityGroupId,
        sourceSecurityGroupId: securityGroups[name].securityGroupId,
        ipProtocol: 'tcp',
        fromPort: redis.port,
        toPort: redis.port,
        description: `${name} tasks to Redis`,
      });
    }

    // --- IAM -----------------------------------------------------------------------------------
    const stack = Stack.of(this);
    const collections = stack.formatArn({
      service: 'rekognition',
      resource: 'collection',
      resourceName: `${config.rekognition.collectionPrefix}*`,
    });
    const objects = (...prefixes: string[]) => prefixes.map((p) => bucket.arnForObjects(`${p}*`));

    // api: presigned multipart uploads into originals/, face search, "delete my face" (search
    // only: the deletion itself is a delete.faces job in the worker), faces and zip jobs.
    taskRoles.api.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'PresignedMultipartUpload',
        actions: [
          's3:PutObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
          's3:GetObject',
        ],
        resources: objects(S3_PREFIXES.originals),
      }),
    );
    taskRoles.api.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // HeadObject is authorised by s3:GetObject (sizes of derivatives before signing URLs).
        sid: 'DerivedHead',
        actions: ['s3:GetObject'],
        resources: objects(S3_PREFIXES.derived),
      }),
    );
    taskRoles.api.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'FaceSearch',
        actions: [
          'rekognition:SearchFacesByImage',
          'rekognition:SearchFaces',
          'rekognition:DescribeCollection',
        ],
        resources: [collections],
      }),
    );
    // faces: index.folder, unindex.folder, delete.faces. zip: zip jobs.
    queues.faces.queue.grantSendMessages(taskRoles.api);
    queues.zip.queue.grantSendMessages(taskRoles.api);

    // worker: media processing, face indexing, zips, purge, reconciliation. One statement per
    // prefix, each with only what that prefix needs.
    taskRoles.worker.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'MediaObjects',
        // Derivatives, magic-byte rejects, zip sources, purge, aborting expired upload sessions.
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
        resources: objects(S3_PREFIXES.originals, S3_PREFIXES.derived),
      }),
    );
    taskRoles.worker.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'UploadRecovery',
        // media.sweep and quota.reconcile.nightly: ListParts tells a finished multipart upload
        // (NoSuchUpload) from a live one before HeadObject and completing the file row.
        actions: ['s3:ListMultipartUploadParts'],
        resources: objects(S3_PREFIXES.originals),
      }),
    );
    taskRoles.worker.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Multipart upload of the archive (Create/UploadPart/Complete are s3:PutObject). The
        // lifecycle rule deletes it; CloudFront serves it.
        sid: 'ZipOutput',
        actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
        resources: objects(S3_PREFIXES.tmpZips),
      }),
    );
    taskRoles.worker.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReconcileScratch',
        // The worker's scan files, the only part of tmp/ it reads back and deletes.
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: objects(S3_PREFIXES.tmpReconcile),
      }),
    );
    taskRoles.worker.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'QuotaReconciliation',
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
      }),
    );
    taskRoles.worker.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'FaceIndex',
        // IndexFaces gets the image as bytes (ADR 0008 section 5), so Rekognition reads nothing
        // from S3 and no tmp/ grant is needed. No SearchFacesByImage: the worker never handles
        // selfies.
        actions: [
          'rekognition:CreateCollection',
          'rekognition:DeleteCollection',
          'rekognition:DescribeCollection',
          'rekognition:IndexFaces',
          'rekognition:DeleteFaces',
          // Reconciliation: find faces in a collection that have no `faces` row, and delete them.
          'rekognition:ListFaces',
          'rekognition:SearchFaces',
        ],
        resources: [collections],
      }),
    );
    // Includes sqs:ChangeMessageVisibility, which the worker uses to heartbeat every job.
    for (const q of QUEUE_NAMES) queues[q].queue.grantConsumeMessages(taskRoles.worker);
    queues.faces.queue.grantSendMessages(taskRoles.worker);
    // media.sweep re-sends `original.completed` for lost media work (ADR 0008 section 3).
    queues.media.queue.grantSendMessages(taskRoles.worker);

    this.services = services;
    this.taskRoles = taskRoles;
    this.logGroups = logGroups;
  }
}
