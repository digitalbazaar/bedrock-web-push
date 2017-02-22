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
    //device: ?, // device UUID of some sort? or client ID? just use `auth`?
    // how can the user know which subscription it is... through the label but they don't set that?
    //applicationServerKey: ? // publicKeyId/hash for service? ... match up with the service being used?
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
