import {
  FACE_DELETION_ALERT_EVENT,
  PAYMENT_GATEWAY_SECRET_ENV,
  PAYMENT_GATEWAY_SECRET_NAMES,
} from '@shotx/shared';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { capSeconds, parseConfig, workerSettings } from '../lib/config';
import { heartbeatQueueIssues } from '../lib/face-limits';
import { collect, rawConfig, synthPlatform, type Synthesized } from './helpers';

/** Phase 4 (billing) infra: gateway and email selection, secrets, SES, alarms and purge. */

type Json = Record<string, unknown>;
const at = (o: Json, ...path: string[]): Json => path.reduce((n, k) => n[k] as Json, o);
const withEdit = (edit: (c: Json) => void): Json => {
  const c = rawConfig();
  edit(c);
  return c;
};

const s = synthPlatform();
const app = s.template(s.platform.app);

function container(synth: Synthesized, service: string): Json {
  const [td] = Object.values(
    synth.template(synth.platform.app).findResources('AWS::ECS::TaskDefinition', {
      Properties: { Family: `shotx-${synth.config.stage}-${service}` },
    }),
  );
  if (td === undefined) throw new Error(`no ${service} task definition`);
  return ((td.Properties as Json).ContainerDefinitions as Json[])[0] as Json;
}
type NameValue = { Name: string; Value?: unknown; ValueFrom?: unknown };
const env = (synth: Synthesized, service: string) =>
  Object.fromEntries(
    ((container(synth, service).Environment ?? []) as NameValue[]).map((e) => [e.Name, e.Value]),
  );
const secrets = (synth: Synthesized, service: string) =>
  Object.fromEntries(
    ((container(synth, service).Secrets ?? []) as NameValue[]).map((e) => [
      e.Name,
      JSON.stringify(e.ValueFrom),
    ]),
  );

/** A non-production stage that relies on the defaults (no billing or email selection). */
const devSynth = synthPlatform((c) => {
  c.stage = 'dev';
  delete (c.billing as Json).paymentGateway;
  delete (c.email as Json).provider;
});

describe('payment gateway and email selection', () => {
  it('uses a real gateway and SES on the prod stage (cdk.json)', () => {
    expect(s.config.stage).toBe('prod');
    expect(s.config.billing.paymentGateway).toBe('omise');
    expect(s.config.email.provider).toBe('ses');
  });

  it('refuses fake on the prod stage', () => {
    const gateway = withEdit((x) => {
      at(x, 'billing').paymentGateway = 'fake';
    });
    expect(() => parseConfig(gateway)).toThrow(
      /must not be fake on the prod stage[\s\S]*at billing\.paymentGateway/,
    );
    const email = withEdit((x) => {
      at(x, 'email').provider = 'fake';
    });
    expect(() => parseConfig(email)).toThrow(
      /must not be fake on the prod stage[\s\S]*at email\.provider/,
    );
    // An unset value falls back to fake, which prod refuses too.
    const unset = withEdit((x) => {
      delete at(x, 'billing').paymentGateway;
      delete at(x, 'email').provider;
    });
    expect(() => parseConfig(unset)).toThrow(/billing\.paymentGateway[\s\S]*email\.provider/);
  });

  it('defaults to fake elsewhere, and warns that NODE_ENV=production refuses it', () => {
    expect(devSynth.config.billing.paymentGateway).toBe('fake');
    expect(devSynth.config.email.provider).toBe('fake');
    expect(env(devSynth, 'api')).toMatchObject({ PAYMENT_GATEWAY: 'fake', EMAIL_PROVIDER: 'fake' });
    const warnings = Annotations.fromStack(devSynth.platform.app).findWarning(
      '*',
      Match.stringLikeRegexp('is fake: api and worker run with NODE_ENV=production'),
    );
    expect(warnings).toHaveLength(2);
    expect(
      Annotations.fromStack(s.platform.app).findWarning('*', Match.stringLikeRegexp('is fake')),
    ).toHaveLength(0);
  });

  it('needs the operator’s secret name for a real gateway', () => {
    const c = withEdit((x) => {
      at(x, 'billing').gatewaySecretName = '';
    });
    expect(() => parseConfig(c)).toThrow(
      /PAYMENT_OMISE_PUBLIC_KEY, PAYMENT_OMISE_SECRET_KEY, PAYMENT_OMISE_WEBHOOK_SECRET[\s\S]*at billing\.gatewaySecretName/,
    );
  });

  it('parses the sender as the services do, at a DNS domain', () => {
    for (const fromAddress of ['not-an-address', 'no-reply@Photos.Example.com', '']) {
      const c = withEdit((x) => {
        at(x, 'email').fromAddress = fromAddress;
      });
      expect(() => parseConfig(c), fromAddress).toThrow(/email/);
    }
    const longName = withEdit((x) => {
      at(x, 'email').fromName = 'x'.repeat(101);
    });
    expect(() => parseConfig(longName)).toThrow(/EMAIL_FROM_NAME/);
  });

  it('refuses billing, email and gateway secret keys in services.env', () => {
    for (const key of [
      'PAYMENT_GATEWAY',
      'EMAIL_PROVIDER',
      'EMAIL_FROM_ADDRESS',
      'EMAIL_FROM_NAME',
      ...PAYMENT_GATEWAY_SECRET_NAMES,
    ]) {
      const c = withEdit((x) => {
        at(x, 'services', 'env', 'backend')[key] = 'x'.repeat(40);
      });
      expect(() => parseConfig(c), key).toThrow(new RegExp(`backend: ${key} is set by infra`));
    }
  });
});

describe('gateway secrets (Secrets Manager -> ECS secrets)', () => {
  const omise = PAYMENT_GATEWAY_SECRET_ENV.omise;

  for (const service of ['api', 'worker']) {
    it(`gives ${service} every secret of the selected gateway from the operator’s secret`, () => {
      const got = secrets(s, service);
      for (const name of omise) {
        expect(got[name], name).toContain(`secret:${s.config.billing.gatewaySecretName}:${name}::`);
      }
      // Never another gateway's secrets.
      for (const name of PAYMENT_GATEWAY_SECRET_NAMES.filter((n) => !omise.includes(n as never))) {
        expect(got, name).not.toHaveProperty(name);
      }
      expect(env(s, service)).toMatchObject({
        PAYMENT_GATEWAY: 'omise',
        EMAIL_PROVIDER: 'ses',
        EMAIL_FROM_ADDRESS: s.config.email.fromAddress,
        EMAIL_FROM_NAME: s.config.email.fromName,
      });
      // Never as plain environment variables.
      for (const name of PAYMENT_GATEWAY_SECRET_NAMES)
        expect(env(s, service), name).not.toHaveProperty(name);
    });
  }

  it('keeps payments and email out of web and admin', () => {
    for (const service of ['web', 'admin']) {
      const keys = [...Object.keys(env(s, service)), ...Object.keys(secrets(s, service))];
      expect(
        keys.filter((k) => /^(PAYMENT_|EMAIL_)/.test(k)),
        service,
      ).toEqual([]);
    }
  });

  it('lets only the api and worker execution roles read the gateway secret', () => {
    const readers = Object.entries(app.findResources('AWS::IAM::Policy'))
      .filter(([, p]) =>
        JSON.stringify(p).includes(`secret:${s.config.billing.gatewaySecretName}-??????`),
      )
      .map(([id]) => id)
      .sort();
    expect(readers).toEqual([
      expect.stringMatching(/^ServicesapiTaskExecutionRoleDefaultPolicy/),
      expect.stringMatching(/^ServicesworkerTaskExecutionRoleDefaultPolicy/),
    ]);
  });

  it('generates the fake webhook secret on a non-production stage', () => {
    const dev = devSynth.template(devSynth.platform.app);
    const [id, secret] = Object.entries(
      dev.findResources('AWS::SecretsManager::Secret', {
        Properties: { Name: 'shotx-dev/payment-gateway-fake' },
      }),
    )[0] as [string, Json];
    expect((secret.Properties as Json).GenerateSecretString).toMatchObject({
      SecretStringTemplate: '{}',
      GenerateStringKey: 'PAYMENT_FAKE_WEBHOOK_SECRET',
      PasswordLength: devSynth.config.billing.fakeWebhookSecretLength,
    });
    for (const service of ['api', 'worker']) {
      const got = secrets(devSynth, service);
      expect(got.PAYMENT_FAKE_WEBHOOK_SECRET, service).toContain(`"Ref":"${id}"`);
      expect(got.PAYMENT_FAKE_WEBHOOK_SECRET, service).toContain(':PAYMENT_FAKE_WEBHOOK_SECRET::');
      for (const name of [
        ...PAYMENT_GATEWAY_SECRET_ENV.omise,
        ...PAYMENT_GATEWAY_SECRET_ENV['2c2p'],
      ]) {
        expect(got, name).not.toHaveProperty(name);
      }
    }
  });

  it('outputs the secret ARN, never its value', () => {
    const outputs = app.findOutputs('PaymentGatewaySecretArn');
    expect(Object.keys(outputs)).toHaveLength(1);
  });
});

describe('email (SES)', () => {
  const domain = s.config.email.fromAddress.split('@')[1] as string;

  it('creates a domain identity for the sender’s domain with Easy DKIM records', () => {
    expect(domain).toBe('photos.example.com');
    app.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: domain,
      ConfigurationSetAttributes: { ConfigurationSetName: Match.anyValue() },
    });
    // The domain is the Route 53 hosted zone, so the three DKIM CNAMEs are created.
    const dkim = Object.values(
      app.findResources('AWS::Route53::RecordSet', { Properties: { Type: 'CNAME' } }),
    );
    expect(dkim).toHaveLength(3);
  });

  it('has a configuration set with reputation metrics, TLS and bounce/complaint suppression', () => {
    app.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: 'shotx-prod-email',
      ReputationOptions: { ReputationMetricsEnabled: true },
      DeliveryOptions: { TlsPolicy: 'REQUIRE' },
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    });
  });

  it('lets api and worker send through that identity only (ses:SendEmail)', () => {
    const statements = Object.entries(app.findResources('AWS::IAM::Policy')).flatMap(([id, p]) =>
      (((p.Properties as Json).PolicyDocument as Json).Statement as Json[]).map(
        (st) => [id, st] as const,
      ),
    );
    const ses = statements.filter(([, st]) => JSON.stringify(st.Action).includes('ses:'));
    expect(ses.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual([
      'ServicesapiTaskTaskRoleDefaultPolicy',
      'ServicesworkerTaskTaskRoleDefaultPolicy',
    ]);
    for (const [id, st] of ses) {
      expect(st.Action, id).toBe('ses:SendEmail');
      const resources = JSON.stringify(st.Resource);
      expect(resources, id).toContain(`:identity/${domain}`);
      expect(resources, id).toContain(':configuration-set/shotx-prod-email');
      expect(resources, id).not.toMatch(/identity\/\*|"\*"/);
    }
  });

  it('outputs the identity and configuration set', () => {
    expect(Object.keys(app.findOutputs('SesIdentityArn'))).toHaveLength(1);
    expect(Object.keys(app.findOutputs('SesConfigurationSet'))).toHaveLength(1);
  });
});

describe('face deletion alert (ADR 0007)', () => {
  it('turns the api’s face_deletion.alert log line into a metric', () => {
    expect(FACE_DELETION_ALERT_EVENT).toBe('face_deletion.alert');
    const [filter] = Object.values(app.findResources('AWS::Logs::MetricFilter'));
    const p = (filter as Json).Properties as Json;
    expect(p.FilterPattern).toBe(`{ $.event = "${FACE_DELETION_ALERT_EVENT}" }`);
    expect(JSON.stringify(p.LogGroupName)).toContain('ServicesapiLogs');
  });

  it('alarms to the alarm topic on any alert line', () => {
    app.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'shotx-prod-face-deletion-alert',
      MetricName: 'FaceDeletionAlerts',
      Namespace: 'ShotX/prod',
      Statistic: 'Sum',
      Period: s.config.alarms.faceDeletionAlertPeriodSeconds,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^AlarmTopic') }],
    });
  });
});

describe('subscription purge (worker)', () => {
  const statements = Object.entries(app.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.startsWith('ServicesworkerTaskTaskRoleDefaultPolicy'))
    .flatMap(([, p]) => ((p.Properties as Json).PolicyDocument as Json).Statement as Json[]);
  const allowed = (action: string) =>
    statements
      .filter((st) => ([] as unknown[]).concat(st.Action).includes(action))
      .map((st) => JSON.stringify(st.Resource))
      .join(' ');

  it('can delete originals/* and derived/* and list them', () => {
    expect(allowed('s3:DeleteObject')).toMatch(/\/originals\/\*/);
    expect(allowed('s3:DeleteObject')).toMatch(/\/derived\/\*/);
    expect(allowed('s3:ListBucket')).toContain('MediaBucket');
  });

  it('can delete the photographer’s Rekognition collection (pg-*) and nothing wider', () => {
    const resources = allowed('rekognition:DeleteCollection');
    expect(resources).toMatch(/:collection\/pg-\*"/);
    expect(resources).not.toMatch(/collection\/\*"/);
  });

  it('runs inside the jobs queue’s heartbeat: the job runtime cap fits SQS and retention', () => {
    const cap = capSeconds(workerSettings(s.config), 'jobs');
    expect(cap).toBe(21_600);
    expect(heartbeatQueueIssues(s.config.queues.jobs, 0, 'jobs', cap)).toEqual([]);
    // A longer purge window is only allowed when retention still covers every attempt.
    const longer = withEdit((x) => {
      at(x, 'services', 'env', 'worker').WORKER_JOB_MAX_RUNTIME_SECONDS = '39600';
    });
    expect(() => parseConfig(longer)).toThrow(/at queues\.jobs\.retentionDays/);
    const retained = withEdit((x) => {
      at(x, 'services', 'env', 'worker').WORKER_JOB_MAX_RUNTIME_SECONDS = '39600';
      at(x, 'queues', 'jobs').retentionDays = 2;
    });
    expect(() => parseConfig(retained)).not.toThrow();
    // The worker heartbeats with the jobs queue's timeout.
    expect(collect(container(s, 'worker').Environment, 'Name')).toContain(
      'JOBS_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
    );
  });
});
