import { Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import * as pricingplanmanager from 'aws-cdk-lib/aws-pricingplanmanager';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';

export interface PricingPlanStackProps extends StackProps {
  readonly config: PlatformConfig;
  readonly distributionArn: string;
  readonly webAclArn: string;
}

/**
 * us-east-1: subscribes the main distribution to the CloudFront flat-rate plan
 * (AWS::PricingPlanManager::Subscription; the PricingPlanManager endpoint is us-east-1 only).
 *
 * Manual steps that CloudFormation can't do:
 * - Paid tiers are created as PENDING_APPROVAL and bill pay-as-you-go until someone calls
 *   ApprovePaidSubscription (console or API) with the SubscriptionArn output.
 * - The tier and usage level can't be changed by a stack update. Change them in the console or
 *   with UpdateSubscription, then update cdk.json to match.
 * - Deleting this stack schedules cancellation at the end of the billing period, and a
 *   distribution can't be deleted while it is subscribed.
 */
export class PricingPlanStack extends Stack {
  constructor(scope: Construct, id: string, props: PricingPlanStackProps) {
    super(scope, id, props);
    const { config } = props;
    const { flatRatePlan } = config.cdn;
    const resourceArns = [props.distributionArn, props.webAclArn];
    if (flatRatePlan.attachHostedZone && config.domain.hostedZoneId !== '') {
      // The plan then covers the hosted zone's fees and queries to ALIAS records.
      resourceArns.push(`arn:${this.partition}:route53:::hostedzone/${config.domain.hostedZoneId}`);
    }
    const subscription = new pricingplanmanager.CfnSubscription(this, 'MainDistributionPlan', {
      planFamily: 'CloudFront',
      planTier: flatRatePlan.tier,
      resourceArns,
    });
    new CfnOutput(this, 'SubscriptionArn', {
      value: subscription.attrArn,
      description:
        'Approve with PricingPlanManager ApprovePaidSubscription (paid tiers start PENDING_APPROVAL)',
    });
    new CfnOutput(this, 'SubscriptionStatus', { value: subscription.attrStatus });
  }
}
