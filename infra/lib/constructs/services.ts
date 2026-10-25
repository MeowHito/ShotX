import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
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
import { faceSearchLimits, type PlatformConfig } from '../config';
import {
  ALB_SERVICES,
  APP_ROUTING_HEADER,
  PATHS,
  PRIMARY_REGION,
  QUEUE_NAMES,
  S3_PREFIXES,
  type AlbServiceName,
  type QueueName,
  type ServiceName,
} from '../constants';
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
      QUEUE_NAMES.map((q) => [`${q.toUpperCase()}_QUEUE_URL`, queues[q].queue.queueUrl]),
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
    // The worker heartbeats long jobs with ChangeMessageVisibility and needs each queue's timeout.
    const workerDerived = Object.fromEntries(
      QUEUE_NAMES.map((q) => [
        `${q.toUpperCase()}_QUEUE_VISIBILITY_TIMEOUT_SECONDS`,
        String(config.queues[q].visibilityTimeoutSeconds),
      ]),
    );
    const signingKey = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CloudFrontSigningKey',
      config.secrets.cloudFrontSigningPrivateKeyName,
    );
    const userPoolEnv = {
      COGNITO_USER_POOL_ID: cognito.userPoolId,
      COGNITO_WEB_CLIENT_ID: cognito.webClientId,
      COGNITO_DOMAIN: cognito.domain,
    };
    const adminPoolEnv = {
      COGNITO_ADMIN_USER_POOL_ID: cognito.adminUserPoolId,
      COGNITO_ADMIN_CLIENT_ID: cognito.adminClientId,
      COGNITO_ADMIN_DOMAIN: cognito.adminDomain,
    };
    const extra = svc.env;

    const environment: Record<ServiceName, Record<string, string>> = {
      web: {
        ...base,
        ...userPoolEnv,
        PORT: String(svc.web.containerPort),
        API_INTERNAL_URL: apiInternalUrl,
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
      },
      worker: {
        ...base,
        ...backend,
        ...extra.common,
        ...extra.backend,
        ...extra.worker,
        ...workerDerived,
      },
    };
    const secrets: Record<ServiceName, Record<string, ecs.Secret>> = {
      web: {},
      admin: {},
      api: { ...backendSecrets, CLOUDFRONT_PRIVATE_KEY: ecs.Secret.fromSecretsManager(signingKey) },
      worker: backendSecrets,
    };

    // --- Services ----------------------------------------------------------------------------
    const services = {} as Record<ServiceName, ecs.FargateService>;
    const taskRoles = {} as Record<ServiceName, iam.IRole>;
    const securityGroups = {} as Record<ServiceName, ec2.SecurityGroup>;

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
      taskDefinition.addContainer(name, {
        image: ecs.ContainerImage.fromEcrRepository(props.repositories[name], svc.imageTag),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup }),
        environment: environment[name],
        secrets: secrets[name],
        portMappings: port === undefined ? [] : [{ containerPort: port, name: 'http' }],
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

    // api: presigned multipart uploads into originals/, face search, "delete my face".
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
        sid: 'FaceSearch',
        actions: [
          'rekognition:SearchFacesByImage',
          'rekognition:SearchFaces',
          'rekognition:DeleteFaces',
          'rekognition:DescribeCollection',
        ],
        resources: [collections],
      }),
    );
    queues.zip.queue.grantSendMessages(taskRoles.api);
    queues.faces.queue.grantSendMessages(taskRoles.api);

    // worker: media processing, face indexing, zips, purge, quota reconciliation.
    taskRoles.worker.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'MediaObjects',
        // Includes tmp/index/*: Rekognition reads the IndexFaces image with the caller's
        // credentials, so the worker must be able to read what it wrote there.
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
        resources: objects(S3_PREFIXES.originals, S3_PREFIXES.derived, S3_PREFIXES.tmp),
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
        actions: [
          'rekognition:CreateCollection',
          'rekognition:DeleteCollection',
          'rekognition:DescribeCollection',
          'rekognition:IndexFaces',
          'rekognition:DeleteFaces',
          // Reconciliation: find faces in a collection that have no `faces` row, and delete them.
          'rekognition:ListFaces',
          'rekognition:SearchFaces',
          'rekognition:SearchFacesByImage',
        ],
        resources: [collections],
      }),
    );
    // Includes sqs:ChangeMessageVisibility, which the worker uses to heartbeat long jobs.
    for (const q of QUEUE_NAMES) queues[q].queue.grantConsumeMessages(taskRoles.worker);
    queues.faces.queue.grantSendMessages(taskRoles.worker);

    this.services = services;
    this.taskRoles = taskRoles;
  }
}
