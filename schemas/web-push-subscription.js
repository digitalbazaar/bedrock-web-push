/*
 * Copyright (c) 2017 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
const schemas = require('bedrock-validation').schemas;

const schema = {
  type: 'object',
  title: 'Web Push Subscription',
  properties: {
    label: schemas.label({required: false}),
    owner: schemas.identifier({required: true}),
    // ID of VAPID key
    vapidKey: schemas.identifier({required: true}),
    // optional device identifier
    device: schemas.identifier({required: false}),
    pushToken: {
      type: 'object',
      properties: {
        endpoint: schemas.identifier({required: true})
        // additionalProperties permitted
      }
    }
  },
  additionalProperties: false,
  errors: {
    invalid: 'The Web Push subscription is invalid.',
    missing: 'Please provide a Web Push subscription.'
  }
};

module.exports = function(extend) {
  if(extend) {
    return bedrock.util.extend(true, bedrock.util.clone(schema), extend);
  }
  return schema;
};
