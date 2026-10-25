import {
  Stack,
  type StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
  SecretValue,
} from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';

export interface AuthStackProps extends StackProps {
  readonly config: PlatformConfig;
}

/** Identity provider names as the apps must send them in `identity_provider=...`. */
export const IDP_NAMES = { google: 'Google', line: 'LINE' } as const;

/**
 * Two Cognito user pools:
 * - users: photographers and viewers. Email/password, Google, and LINE Login (OIDC). TOTP MFA is
 *   optional.
 * - admins: the admin app only. No self sign-up, no federation, TOTP MFA required. Cognito can't
 *   require MFA for one group inside a pool, so a separate pool is how admin MFA is enforced.
 *
 * The app's roles (photographer/user/admin) live in the `users` table, keyed by `cognito_sub`.
 * OAuth client secrets for Google and LINE are read from Secrets Manager at deploy time; they're
 * created manually before the first deploy and never appear in the template.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;
  readonly adminUserPool: cognito.UserPool;
  readonly adminClient: cognito.UserPoolClient;
  readonly adminUserPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;
    const { auth, domain } = config;
    const prefix = `shotx-${config.stage}`;
    const removalPolicy = RemovalPolicy.RETAIN;

    // --- Photographers and viewers ------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      // Not required: LINE only returns an email after LINE approves the email permission.
      standardAttributes: {
        email: { required: false, mutable: true },
        fullname: { required: false, mutable: true },
        profilePicture: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: auth.passwordMinLength,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: auth.deletionProtection,
      removalPolicy,
    });

    const google = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool: this.userPool,
      clientId: auth.google.clientId,
      clientSecretValue: SecretValue.secretsManager(auth.google.clientSecretName),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
      },
    });

    // LINE Login v2.1 is an OIDC provider: ES256-signed ID tokens, client_secret_post supported.
    // Cognito endpoints are discovered from {issuer}/.well-known/openid-configuration.
    const line = new cognito.UserPoolIdentityProviderOidc(this, 'Line', {
      userPool: this.userPool,
      name: IDP_NAMES.line,
      clientId: auth.line.channelId,
      // Dynamic reference ({{resolve:secretsmanager:...}}), resolved by CloudFormation at deploy.
      clientSecret: SecretValue.secretsManager(auth.line.channelSecretName).unsafeUnwrap(),
      issuerUrl: auth.line.issuerUrl,
      scopes: auth.line.scopes,
      attributeRequestMethod: cognito.OidcAttributeRequestMethod.GET,
      attributeMapping: {
        email: cognito.ProviderAttribute.other('email'),
        fullname: cognito.ProviderAttribute.other('name'),
        profilePicture: cognito.ProviderAttribute.other('picture'),
      },
    });

    const mainUrl = `https://${domain.main}`;
    this.webClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${prefix}-web`,
      // Public client: authorization code flow with PKCE.
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(auth.accessTokenMinutes),
      idTokenValidity: Duration.minutes(auth.idTokenMinutes),
      refreshTokenValidity: Duration.days(auth.refreshTokenDays),
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
        cognito.UserPoolClientIdentityProvider.custom(IDP_NAMES.line),
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${mainUrl}${auth.callbackPath}`, ...auth.extraCallbackUrls],
        logoutUrls: [`${mainUrl}${auth.logoutPath}`, ...auth.extraLogoutUrls],
      },
    });
    this.webClient.node.addDependency(google, line);

    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: auth.domainPrefix },
    });

    // --- Admins -------------------------------------------------------------------------------
    this.adminUserPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: `${prefix}-admins`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: auth.adminPasswordMinLength,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: auth.deletionProtection,
      removalPolicy,
    });

    const adminUrl = `https://${domain.admin}`;
    this.adminClient = this.adminUserPool.addClient('AdminClient', {
      userPoolClientName: `${prefix}-admin`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(auth.accessTokenMinutes),
      idTokenValidity: Duration.minutes(auth.idTokenMinutes),
      refreshTokenValidity: Duration.hours(auth.adminRefreshTokenHours),
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${adminUrl}${auth.adminCallbackPath}`],
        logoutUrls: [`${adminUrl}${auth.adminLogoutPath}`],
      },
    });
    this.adminUserPoolDomain = this.adminUserPool.addDomain('AdminDomain', {
      cognitoDomain: { domainPrefix: auth.adminDomainPrefix },
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'WebClientId', { value: this.webClient.userPoolClientId });
    new CfnOutput(this, 'UserPoolDomain', { value: this.userPoolDomain.baseUrl() });
    new CfnOutput(this, 'AdminUserPoolId', { value: this.adminUserPool.userPoolId });
    new CfnOutput(this, 'AdminClientId', { value: this.adminClient.userPoolClientId });
    new CfnOutput(this, 'AdminUserPoolDomain', { value: this.adminUserPoolDomain.baseUrl() });
  }
}
