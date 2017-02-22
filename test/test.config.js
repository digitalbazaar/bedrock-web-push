/*!
 * Bedrock Web Push Application Server Test Configuration.
 *
 * Copyright (c) 2017 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
const config = bedrock.config;
const path = require('path');
const permissions = config.permission.permissions;
const roles = config.permission.roles;

config.mocha.tests.push(path.join(__dirname, 'mocha'));

// mongodb config
config.mongodb.name = 'bedrock_web_push_test';
// drop all collections on initialization
config.mongodb.dropCollections = {};
config.mongodb.dropCollections.onInit = true;
config.mongodb.dropCollections.collections = [];

roles['bedrock-web-push.test'] = {
  id: 'bedrock-web-push.test',
  label: 'Test Role',
  comment: 'Role for Test User',
  sysPermission: [
    permissions.WEB_PUSH_SUBSCRIPTION_ACCESS.id,
    permissions.WEB_PUSH_SUBSCRIPTION_INSERT.id,
    permissions.WEB_PUSH_SUBSCRIPTION_REMOVE.id
  ]
};
