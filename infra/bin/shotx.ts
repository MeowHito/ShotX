import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { buildPlatform } from '../lib/platform';

const app = new App();
buildPlatform(app, loadConfig(app));
app.synth();
