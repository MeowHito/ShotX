import { Stack, type StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';

export interface DataStackProps extends StackProps {
  readonly config: PlatformConfig;
  readonly vpc: ec2.IVpc;
}

/** Redis ACL rules of the built-in `default` user: disabled, no commands. */
export const REDIS_DISABLED_ACCESS_STRING = 'off -@all';

/**
 * PostgreSQL on RDS (Multi-AZ, encrypted, TLS enforced) and ElastiCache Redis (Multi-AZ with
 * automatic failover, TLS in transit, encrypted at rest), both in the isolated data subnets.
 * Ingress is opened per service in the App stack.
 *
 * Redis authenticates with RBAC: a user group holding a password user for api and worker
 * (`redis.username`, password generated into Secrets Manager) and a replacement `default` user
 * that is switched off, so connections that skip AUTH can't run any command. RBAC rather than a
 * single AUTH token because the token is a shared superuser credential that can't be scoped or
 * rotated per client, and RBAC is what ElastiCache supports going forward (it requires TLS,
 * which is on). Passwords reach the template only as Secrets Manager dynamic references.
 *
 * The `ltree` extension is created by the database migrations (packages/db), not here.
 */
export class DataStack extends Stack {
  readonly database: rds.DatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly databaseHost: string;
  readonly databasePort: number;
  readonly databaseName: string;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  readonly redisSecurityGroup: ec2.SecurityGroup;
  readonly redisHost: string;
  readonly redisPort: number;
  /** JSON `{ username, password }` of the Redis user api and worker authenticate as. */
  readonly redisSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    const { database: db, redis } = config;
    const prefix = `shotx-${config.stage}`;
    const dataSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    // --- PostgreSQL --------------------------------------------------------------------------
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'RDS PostgreSQL; ingress from api and worker only',
      allowAllOutbound: false,
    });

    const [major] = db.engineVersion.split('.');
    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.of(db.engineVersion, major ?? db.engineVersion),
    });

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine,
      instanceType: new ec2.InstanceType(db.instanceType),
      vpc,
      vpcSubnets: dataSubnets,
      securityGroups: [this.databaseSecurityGroup],
      // Spec invariant: RDS Multi-AZ. Not a tunable.
      multiAz: true,
      publiclyAccessible: false,
      port: db.port,
      databaseName: db.databaseName,
      credentials: rds.Credentials.fromGeneratedSecret(db.username, {
        secretName: `${prefix}/database/master`,
      }),
      allocatedStorage: db.allocatedStorageGiB,
      maxAllocatedStorage: db.maxAllocatedStorageGiB,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(db.backupRetentionDays),
      deletionProtection: db.deletionProtection,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      parameterGroup: new rds.ParameterGroup(this, 'PostgresParams', {
        engine,
        description: 'ShotX PostgreSQL parameters',
        parameters: { 'rds.force_ssl': '1' },
      }),
      monitoringInterval:
        db.monitoringIntervalSeconds > 0
          ? Duration.seconds(db.monitoringIntervalSeconds)
          : undefined,
      enablePerformanceInsights: db.performanceInsights,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: db.logRetentionDays,
    });
    if (this.database.secret === undefined) throw new Error('RDS secret was not generated');
    this.databaseSecret = this.database.secret;
    this.databaseHost = this.database.dbInstanceEndpointAddress;
    this.databasePort = db.port;
    this.databaseName = db.databaseName;

    // --- Redis -------------------------------------------------------------------------------
    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc,
      description: 'ElastiCache Redis; ingress from api and worker only',
      allowAllOutbound: false,
    });
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'ShotX Redis subnets',
      subnetIds: vpc.selectSubnets(dataSubnets).subnetIds,
    });

    const generatedPassword = (sid: string, secretName: string, username: string) =>
      new secretsmanager.Secret(this, sid, {
        secretName,
        description: `ElastiCache RBAC user ${username}`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username }),
          generateStringKey: 'password',
          // ElastiCache passwords: 16-128 printable characters, without , " / @ or spaces.
          excludePunctuation: true,
          includeSpace: false,
          passwordLength: 64,
        },
      });
    const user = (
      cid: string,
      userId: string,
      userName: string,
      accessString: string,
      secret: secretsmanager.ISecret,
    ) =>
      new elasticache.CfnUser(this, cid, {
        engine: redis.engine,
        userId,
        userName,
        accessString,
        authenticationMode: {
          Type: 'password',
          Passwords: [secret.secretValueFromJson('password').unsafeUnwrap()],
        },
      });

    const appSecret = generatedPassword(
      'RedisAppUserSecret',
      `${prefix}/redis/${redis.username}`,
      redis.username,
    );
    const appUser = user(
      'RedisAppUser',
      `${prefix}-app`,
      redis.username,
      redis.accessString,
      appSecret,
    );
    // Its password is never handed to any service, and the user is off. A password rather than
    // nopass keeps it unusable even if someone switches it on.
    const defaultUser = user(
      'RedisDefaultUser',
      `${prefix}-default`,
      'default',
      REDIS_DISABLED_ACCESS_STRING,
      generatedPassword('RedisDefaultUserSecret', `${prefix}/redis/default`, 'default'),
    );
    const userGroup = new elasticache.CfnUserGroup(this, 'RedisUserGroup', {
      engine: redis.engine,
      userGroupId: `${prefix}-redis`,
      userIds: [defaultUser.userId, appUser.userId],
    });
    userGroup.node.addDependency(defaultUser, appUser);

    const replicationGroup = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: `${prefix} cache, rate limits and short-lived grants`,
      engine: redis.engine,
      engineVersion: redis.engineVersion,
      cacheNodeType: redis.nodeType,
      numCacheClusters: redis.numCacheClusters,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      userGroupIds: [userGroup.userGroupId],
      port: redis.port,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [this.redisSecurityGroup.securityGroupId],
      snapshotRetentionLimit: redis.snapshotRetentionDays,
      autoMinorVersionUpgrade: true,
    });
    replicationGroup.node.addDependency(userGroup);
    replicationGroup.applyRemovalPolicy(RemovalPolicy.SNAPSHOT);
    this.redisHost = replicationGroup.attrPrimaryEndPointAddress;
    this.redisPort = redis.port;
    this.redisSecret = appSecret;

    new CfnOutput(this, 'DatabaseHost', { value: this.databaseHost });
    new CfnOutput(this, 'DatabaseSecretArn', { value: this.databaseSecret.secretArn });
    // No credentials in the URL; api and worker get them from RedisSecretArn as ECS secrets.
    new CfnOutput(this, 'RedisUrl', { value: `rediss://${this.redisHost}:${this.redisPort}` });
    new CfnOutput(this, 'RedisSecretArn', { value: appSecret.secretArn });
  }
}
