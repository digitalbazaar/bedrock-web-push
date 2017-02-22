/*
 * Bedrock Web Push Application Server Module.
 *
 * Copyright (c) 2017 Digital Bazaar, Inc. All rights reserved.
 */
const async = require('async');
const bedrock = require('bedrock');
const brPassport = require('bedrock-passport');
const brPermission = require('bedrock-permission');
const brRest = require('bedrock-rest');
const config = bedrock.config;
const database = require('bedrock-mongodb');
const ensureAuthenticated = brPassport.ensureAuthenticated;
const uuidV4 = require('uuid/v4');
const util = require('util');
const validate = require('bedrock-validation').validate;
const BedrockError = bedrock.util.BedrockError;
require('bedrock-server');
require('bedrock-express');

// load config defaults
require('./config');

// module permissions
const PERMISSIONS = bedrock.config.permission.permissions;

// module API
const api = {
  subscriptions: {}
};
module.exports = api;

const logger = bedrock.loggers.get('app');
const modcfg = config['web-push'];
let subscriptionCollection;

// TODO: handle vapid key generation and storage?
// TODO: try to use bedrock-key for that?
// TODO: map service name/identifier to VAPID key and allow multiple keys
//   where the service name must be given when pushing a message?
// TODO: maybe don't reuse bedrock-key for VAPID right now ... leave a TODO
//   for in the future?

bedrock.events.on('bedrock-mongodb.ready', callback => {
  async.auto({
    openCollections: callback => {
      database.openCollections(
        Object.keys(modcfg.collections).map(key => modcfg.collections[key]),
        // Object.values(modCfg.collections) ES2017 please
        callback);
    },
    createIndexes: ['openCollections', (results, callback) => {
      subscriptionCollection =
        database.collections[modcfg.collections.subscription];

      database.createIndexes([{
        collection: modcfg.collections.subscription,
        fields: {id: 1},
        options: {unique: true, background: false}
      }, {
        collection: modcfg.collections.subscription,
        fields: {owner: 1, id: 1},
        options: {unique: true, background: false}
      }, {
        collection: modcfg.collections.subscription,
        fields: {endpoint: 1},
        options: {unique: true, background: false}
      }], callback);
    }]
  }, err => callback(err));
});

bedrock.events.on('bedrock-express.configure.routes', app => {
  const routes = config['web-push'].routes;

  // add a new subscription
  app.post(
    routes.subscriptions,
    ensureAuthenticated,
    validate('bedrock-web-push.postSubscription'),
    (req, res, next) => {
      // generate new random ID for subscription
      const subscription = req.body;
      subscription.id = api.subscriptions.createId();
      api.subscriptions.add(req.user.identity, req.body, err =>
        err ? next(err) : res.status(201).location(subscription.id).end());
    });

  // remove a subscription
  app.delete(
    routes.subscriptions + '/:id',
    ensureAuthenticated, function(req, res, next) {
    const id = api.subscriptions.createId(req.params.id);
    api.subscriptions.remove(req.user.identity, id, err =>
      err ? next(err) : res.status(204).end());
    });

  // get all subscriptions (e.g. to allow users to manage them)
  app.get(
    routes.subcriptions, ensureAuthenticated, brRest.when.prefers.ld,
    brRest.makeResourceHandler({
      get: (req, res, callback) => {
        const identity = req.user.identity;
        const query = {};
        const fields = {};
        const options = {};
        if(req.query.owner) {
          query.owner = database.hash(req.query.owner);
        }
        if(req.query.endpoint) {
          query.endpoint = database.hash(req.query.endpoint);
        }
        api.subscriptions.getAll(
          identity, query, fields, options, (err, records) => callback(
            err, err ? null : records.map(record => record.subscription)));
      }
    }));

  // get a single subscription
  app.get(
    routes.subscriptions + '/:id',
    ensureAuthenticated, (req, res, next) => {
      const id = api.subscriptions.createId(req.params.id);
      api.subscriptions.get(req.user.identity, id, (err, subscription) => err ?
        next(err) :
        res.status(200).type('application/ld+json').send(subscription));
    });
});

api.subscriptions.createId = function(name = uuidV4()) {
  return util.format(
    '%s%s/%s', config.server.baseUri, config['web-push'].routes.subscriptions,
    encodeURIComponent(name));
};

// TODO: implement API

/**
 * Adds a new Web Push subscription.
 *
 * @param actor the Identity performing the action.
 * @param subscription the subscription to add.
 * @param callback(err, record) called once the operation completes.
 */
api.subscriptions.add = function(actor, subscription, callback) {
  if(!subscription || typeof subscription !== 'object') {
    throw new TypeError('subscription must be an object.');
  }

  async.auto({
    checkPermission: callback => brPermission.checkPermission(
      actor, PERMISSIONS.WEB_PUSH_SUBSCRIPTION_INSERT,
      {resource: [subscription, subscription.owner]}, callback),
    insert: ['checkPermission', (results, callback) => {
      logger.debug('[bedrock-web-push] adding subscription', subscription);

      const now = Date.now();
      const record = {
        id: database.hash(subscription.id),
        owner: database.hash(subscription.owner),
        endpoint: database.hash(subscription.pushToken.endpoint),
        meta: {
          created: now,
          updated: now,
          status: 'active'
        },
        subscription: database.encode(subscription)
      };
      subscriptionCollection.insert(
        record, database.writeOptions, (err, result) => {
          if(err) {
            return callback(err);
          }
          result.ops[0].subscription = database.decode(
            result.ops[0].subscription);
          callback(null, result.ops[0]);
        });
    }]
  }, (err, results) => callback(err, results.insert));
};

/**
 * Gets a Web Push subscription.
 *
 * @param actor the Identity performing the action.
 * @param id the ID of the subscription to retrieve.
 * @param [options] the options to use:
 *          [meta] true to get the meta data for the subscription too, changing
 *            the value passed to the callback to be:
 *            {subscription: ..., meta: ...}.
 * @param callback(err, subscription) called once the operation completes.
 */
api.subscriptions.get = function(actor, id, options, callback) {
  if(typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  async.auto({
    find: callback => subscriptionCollection.findOne(
      {id: database.hash(id), 'meta.status': 'active'}, {}, callback),
    exists: ['find', (results, callback) => {
      if(!results.find) {
        return callback(new BedrockError(
          'Web Push subscription not found.', 'NotFound',
          {subscription: id, httpStatusCode: 404, public: true}));
      }
      callback();
    }],
    checkPermission: ['exists', (results, callback) =>
      brPermission.checkPermission(
        actor, PERMISSIONS.WEB_PUSH_SUBSCRIPTION_ACCESS,
        {resource: [
          results.find.subscription, results.find.subscription.owner]},
          callback)]
  }, (err, results) => {
    if(err) {
      return callback(err);
    }
    const subscription = database.decode(results.find.subscription);
    if(options.meta === true) {
      return callback(
        null, {subscription: subscription, meta: results.find.meta});
    }
    callback(null, subscription);
  });
};

/**
 * Gets all Web Push subscriptions matching the given query.
 *
 * @param actor the Identity performing the action.
 * @param [query] the optional query to use (default: {}).
 * @param [fields] optional fields to include or exclude (default: {}).
 * @param [options] options (eg: 'sort', 'limit').
 * @param callback(err, records) called once the operation completes.
 */
api.subscriptions.getAll = function(actor, query, fields, options, callback) {
  // handle args
  if(typeof query === 'function') {
    callback = query;
    query = null;
    fields = null;
  } else if(typeof fields === 'function') {
    callback = fields;
    fields = null;
  } else if(typeof options === 'function') {
    callback = options;
    options = null;
  }

  query = query || {};
  fields = fields || {};
  // `id` and `owner` are required for permission check, if they were not
  // specified fields, they will be removed later
  let stripId = false;
  let stripOwner = false;
  if(Object.keys(fields).length > 0 && !fields.subscription) {
    stripId = !fields['subscription.id'];
    stripOwner = !fields['subscription.owner'];
  }
  options = options || {};
  async.auto({
    // TODO: use a cursor instead of `toArray` and manually apply any `limit`
    // as records may be weeded out based on permissions
    find: callback => subscriptionCollection.find(query, fields, options)
      .toArray(callback),
    // check to make sure the caller is allowed to access the subscription
    getAuthorized: ['find', (results, callback) => async.filterSeries(
      results.find, (record, callback) => brPermission.checkPermission(
        actor, PERMISSIONS.WEB_PUSH_SUBSCRIPTION_ACCESS, {
          resource: [record.subscription.id, record.subscription.owner]
        }, err => callback(null, !err)), callback)]
  }, (err, results) => {
    if(err) {
      return callback(err);
    }
    // decode records
    for(const record of results.getAuthorized) {
      if(stripId) {
        delete record.subscription.id;
      }
      if(stripOwner) {
        delete record.subscription.owner;
      }
      if('subscription' in record) {
        record.subscription = database.decode(record.subscription);
      }
    }
    callback(null, results.getAuthorized);
  });
};

/**
 * Deletes a Web Push subscription. The client (webapp) will need to
 * unsubscribe from the push service on its own. This method will simply
 * remove the application server's record of the subscription, thereby
 * preventing it from sending any more push messages to the push service
 * via that subscription.
 *
 * @param actor the Identity performing the action.
 * @param id the ID of the subscription.
 * @param callback(err) called once the operation completes.
 */
api.subscriptions.remove = function(actor, id, callback) {
  async.auto({
    get: callback => api.subscription.get(null, id, callback),
    checkPermission: ['get', (results, callback) =>
      brPermission.checkPermission(
        actor, PERMISSIONS.WEB_PUSH_SUBSCRIPTION_REMOVE,
        {resource: [
          results.get.subscription.id, results.get.subscription.owner]},
          callback)],
    remove: ['checkPermission', (results, callback) =>
      subscriptionCollection.remove(
        {id: database.hash(id)}, database.writeOptions,
        err => callback(err))]
  }, err => callback(err));
};

// TODO: implement sending a message to a push service
//   require service identifier for looking up the VAPID key for the service
//   that is pushing the message?
