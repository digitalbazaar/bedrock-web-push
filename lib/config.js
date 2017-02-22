/*
 * Bedrock Web Push Application Server Module Configuration.
 *
 * Copyright (c) 2017 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
require('bedrock-permission');
const cc = bedrock.util.config.main.computer();
const config = bedrock.config;
const path = require('path');

config['web-push'] = {};
config['web-push'].collections = {
  subscription: 'web_push_subscription'
};
config['web-push'].routes = {};
config['web-push'].routes.basePath = '/web-push';
cc('web-push.routes.subscriptions', () =>
  config['web-push'].routes.basePath + '/subscriptions');

// load validation schemas
config.validation.schema.paths.push(
  path.join(__dirname, '..', 'schemas')
);

// permissions
const permissions = config.permission.permissions;
permissions.WEB_PUSH_SUBSCRIPTION_ACCESS = {
  id: 'WEB_PUSH_SUBSCRIPTION_ACCESS',
  label: 'Access an Web Push subscription',
  comment: 'Required to access a Web Push subscription.'
};
permissions.WEB_PUSH_SUBSCRIPTION_INSERT = {
  id: 'WEB_PUSH_SUBSCRIPTION_INSERT',
  label: 'Insert a Web Push subscription',
  comment: 'Required to insert a Web Push subscription.'
};
permissions.WEB_PUSH_SUBSCRIPTION_REMOVE = {
  id: 'WEB_PUSH_SUBSCRIPTION_REMOVE',
  label: 'Remove a Web Push subscription',
  comment: 'Required to remove a Web Push subscription.'
};
