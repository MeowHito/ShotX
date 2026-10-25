import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import { emailIdentityDomain, type PlatformConfig } from '../config';

export interface EmailProps {
  readonly config: PlatformConfig;
  /** Roles that send email (api: receipts; worker: reminders and lifecycle notices). */
  readonly senders: readonly iam.IRole[];
}

/**
 * Amazon SES in ap-southeast-1: a domain identity for the domain of `email.fromAddress` (Easy
 * DKIM; the records are created when that domain is the Route 53 hosted zone, otherwise they are
 * added by hand), and a configuration set that is the identity's default, so every message gets
 * reputation metrics and account-level bounce/complaint suppression without the services naming
 * it.
 *
 * New accounts are in the SES sandbox: until production access is granted, mail only reaches
 * verified recipients (infra/README.md "Before launch").
 */
export class Email extends Construct {
  readonly identity: ses.EmailIdentity;
  readonly configurationSet: ses.ConfigurationSet;
  readonly identityArn: string;

  constructor(scope: Construct, id: string, props: EmailProps) {
    super(scope, id);
    const { config } = props;
    const prefix = `shotx-${config.stage}`;
    const domain = emailIdentityDomain(config);
    const configurationSetName = `${prefix}-email`;

    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName,
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
    });

    const zone =
      config.domain.hostedZoneName === domain
        ? route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
            hostedZoneId: config.domain.hostedZoneId,
            zoneName: config.domain.hostedZoneName,
          })
        : undefined;
    this.identity = new ses.EmailIdentity(this, 'Identity', {
      identity:
        zone === undefined ? ses.Identity.domain(domain) : ses.Identity.publicHostedZone(zone),
      configurationSet: this.configurationSet,
    });

    const stack = Stack.of(this);
    this.identityArn = stack.formatArn({
      service: 'ses',
      resource: 'identity',
      resourceName: domain,
    });
    const configurationSetArn = stack.formatArn({
      service: 'ses',
      resource: 'configuration-set',
      resourceName: configurationSetName,
    });
    // SESv2 SendEmail is authorised on the identity and on the configuration set it uses. No
    // ses:FromAddress condition: with a display name ("ShotX <no-reply@...>") it would not match a
    // plain address, and the identity already confines sending to this one domain.
    for (const role of props.senders) {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'SendEmail',
          actions: ['ses:SendEmail'],
          resources: [this.identityArn, configurationSetArn],
        }),
      );
    }
  }
}
