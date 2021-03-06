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
const request = require('request');
const uuidV4 = require('uuid/v4');
const util = require('util');
const validate = require('bedrock-validation').validate;
const webpush = require('web-push');
const BedrockError = bedrock.util.BedrockError;
const Url = require('url');
require('bedrock-server');
require('bedrock-express');

// load config defaults
require('./config');

// module permissions
const PERMISSIONS = bedrock.config.permission.permissions;

// default TTL is 1 week (in seconds)
const DEFAULT_PUSH_MESSAGE_TTL = 604800;

// module API
const api = {
  vapidKeys: {},
  subscriptions: {}
};
module.exports = api;

const logger = bedrock.loggers.get('app');
const modcfg = config['web-push'];
// TODO: store vapid keys w/SSM
let vapidKeyCollection, subscriptionCollection;

bedrock.events.on('bedrock-mongodb.ready', callback => {
  async.auto({
    openCollections: callback => {
      database.openCollections(
        Object.keys(modcfg.collections).map(key => modcfg.collections[key]),
        // Object.values(modCfg.collections) ES2017 please
        callback);
    },
    createIndexes: ['openCollections', (results, callback) => {
      vapidKeyCollection =
        database.collections[modcfg.collections.vapidKey];
      subscriptionCollection =
        database.collections[modcfg.collections.subscription];

      database.createIndexes([{
        collection: modcfg.collections.vapidKey,
        fields: {id: 1},
        options: {unique: true, background: false}
      }, {
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

  // get a vapid key
  app.get(
    routes.vapidKeys + '/:id',
    ensureAuthenticated, (req, res, next) => {
      const id = api.vapidKeys.createId(req.params.id);
      api.vapidKeys.get(req.user.identity, id, (err, vapidKey) => err ?
        next(err) :
        res.status(200).type('application/ld+json').send(vapidKey));
    });

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
    routes.subscriptions, ensureAuthenticated, brRest.when.prefers.ld,
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

api.vapidKeys.createId = function(name) {
  return util.format(
    '%s%s/%s', config.server.baseUri, config['web-push'].routes.vapidKeys,
    encodeURIComponent(name));
};

api.vapidKeys.generate = function(name, callback) {
  const vapidKeys = webpush.generateVAPIDKeys();
  callback(null, {
    id: api.vapidKeys.createId(name),
    publicKeyBase64Url: vapidKeys.publicKey,
    privateKeyBase64Url: vapidKeys.privateKey
  });
};

/**
 * Adds a new Web Push VAPID key.
 *
 * @param actor the Identity performing the action.
 * @param vapidKey the vapidKey to add.
 * @param options the options to use:
 *          meta the meta to use:
 *           email the email address for the push service to contact
 *             wrt. messages sent using the VAPID key.
 * @param callback(err, record) called once the operation completes.
 */
api.vapidKeys.add = function(actor, vapidKey, options, callback) {
  if(!vapidKey || typeof vapidKey !== 'object') {
    throw new TypeError('vapidKey must be an object.');
  }
  if(!options || typeof options !== 'object') {
    throw new TypeError('options must be an object.');
  }
  if(!options.meta || typeof options.meta !== 'object') {
    throw new TypeError('options.meta must be an object.');
  }
  if(!options.meta.email || typeof options.meta.email !== 'string') {
    throw new TypeError('options.meta.email must be a string.');
  }

  async.auto({
    checkPermission: callback => brPermission.checkPermission(
      actor, PERMISSIONS.WEB_PUSH_VAPID_KEY_INSERT,
      {resource: vapidKey}, callback),
    insert: ['checkPermission', (results, callback) => {
      logger.debug('[bedrock-web-push] adding VAPID key', {
        id: vapidKey.id,
        publicKeyBase64Url: vapidKey.publicKeyBase64Url
      });

      const now = Date.now();
      const meta = bedrock.util.clone(options.meta);
      meta.created = now;
      meta.updated = now;
      meta.status = 'active';
      const record = {
        id: database.hash(vapidKey.id),
        meta: meta,
        vapidKey: database.encode(vapidKey)
      };
      vapidKeyCollection.insert(
        record, database.writeOptions, (err, result) => {
          if(err) {
            return callback(err);
          }
          result.ops[0].vapidKey = database.decode(
            result.ops[0].vapidKey);
          callback(null, result.ops[0]);
        });
    }]
  }, (err, results) => callback(err, results.insert));
};

/**
 * Gets a Web Push VAPID key.
 *
 * @param actor the Identity performing the action.
 * @param id the ID of the VAPID key to retrieve.
 * @param [options] the options to use:
 *          [private] true to get the private key too if permitted.
 *          [meta] true to get the meta data for the VAPID key too, changing
 *            the value passed to the callback to be:
 *            {vapidKey: ..., meta: ...}.
 * @param callback(err, vapidKey) called once the operation completes.
 */
api.vapidKeys.get = function(actor, id, options, callback) {
  if(typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  async.auto({
    find: callback => vapidKeyCollection.findOne(
      {id: database.hash(id), 'meta.status': 'active'}, {}, callback),
    exists: ['find', (results, callback) => {
      if(!results.find) {
        return callback(new BedrockError(
          'Web Push VAPID key not found.', 'NotFound',
          {vapidKey: id, httpStatusCode: 404, public: true}));
      }
      callback();
    }],
    checkPermission: ['exists', (results, callback) => {
      if(!options.private) {
        // permission check not necessary for public key access
        delete results.find.privateKey;
        return callback();
      }
      brPermission.checkPermission(
        actor, PERMISSIONS.WEB_PUSH_VAPID_KEY_ACCESS,
        {resource: results.find.vapidKey}, callback);
    }]
  }, (err, results) => {
    if(err) {
      return callback(err);
    }
    const vapidKey = database.decode(results.find.vapidKey);
    if(options.meta === true) {
      return callback(
        null, {vapidKey: vapidKey, meta: results.find.meta});
    }
    callback(null, vapidKey);
  });
};

api.subscriptions.createId = function(name = uuidV4()) {
  return util.format(
    '%s%s/%s', config.server.baseUri, config['web-push'].routes.subscriptions,
    encodeURIComponent(name));
};

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
            if(database.isDuplicateError(err)) {
              return callback(new BedrockError(
                'Duplicate subscription.',
                'DuplicateRecord', {
                  httpStatusCode: 409,
                  endpoint: subscription.pushToken.endpoint,
                  public: true
                }));
            }
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
    get: callback => api.subscriptions.get(null, id, callback),
    checkPermission: ['get', (results, callback) =>
      brPermission.checkPermission(
        actor, PERMISSIONS.WEB_PUSH_SUBSCRIPTION_REMOVE,
        {resource: [results.get.id, results.get.owner]}, callback)],
    remove: ['checkPermission', (results, callback) =>
      subscriptionCollection.remove(
        {id: database.hash(id)}, database.writeOptions,
        err => callback(err))]
  }, err => callback(err));
};

/**
 * Sends a push message to the push service associated with a subscription.
 *
 * This method presently has no capability checks associated with it; it
 * is assumed to be called internally when triggered via some other
 * action that was appropriately authorized.
 *
 * @param actor the Identity performing the action.
 * @param id the ID of the subscription.
 * @param options the options to use:
 *          [ttl] the time to live for the message.
 *          [payload] the payload for the message.
 * @param callback(err) called once the operation completes.
 */
api.subscriptions.send = function(actor, subscriptionId, options, callback) {
  if(typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = bedrock.util.extend({payload: null}, options || {});
  async.auto({
    getSubscription: callback => api.subscriptions.get(
      null, subscriptionId, callback),
    getVapidKey: ['getSubscription', (results, callback) =>
      api.vapidKeys.get(
        null, results.getSubscription.vapidKey, {
          private: true, meta: true
        }, callback)],
    send: ['getVapidKey', (results, callback) => {
      const {
        getSubscription: subscription,
        getVapidKey: {
          vapidKey, meta: {email}
        }
      } = results;
      // TODO: raise error when payload is specified but can't be sent
      if(!subscription.pushToken.keys) {
        options.payload = null;
      }
      const req = createPushRequest(subscription, vapidKey, email, options);
      request.post(req.endpoint, {
        headers: req.headers,
        body: req.body,
        strictSSL: config.jsonld.strictSSL
      }, (err, res) => {
        if(err) {
          return callback(err);
        }
        if(res.statusCode !== 201) {
          return callback(new BedrockError(
            'Unexpected response code from Web Push service.', 'ProtocolError',
            {subscription: subscriptionId, httpStatusCode: res.statusCode}));
        }
        callback();
      });
    }]
  }, err => callback(err));
};

/**
 * Sends a push message via every subscription owned by a particular identity
 * for a particular VAPID key ID.
 *
 * This method presently has no capability checks associated with it; it
 * is assumed to be called internally when triggered via some other
 * action that was appropriately authorized.
 *
 * @param actor the Identity performing the action.
 * @param identityId the ID of the identity.
 * @param vapidKeyId the ID of the VAPID key.
 * @param options the options to use:
 *          [ttl] the time to live for the message.
 *          [payload] the payload for the message.
 *          [removeBadSubscriptions] true to remove any bad subscriptions.
 * @param callback(err) called once the operation completes.
 */
api.subscriptions.sendAll = function(
  actor, identityId, vapidKeyId, options, callback) {
  if(typeof identityId !== 'string') {
    throw new TypeError('identityId must be a string.');
  }
  if(typeof vapidKeyId !== 'string') {
    throw new TypeError('vapidKeyId must be a string.');
  }
  if(typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  async.auto({
    getSubscriptions: callback => api.subscriptions.getAll(null, {
      owner: database.hash(identityId),
      'subscription.vapidKey': vapidKeyId
    }, {'subscription.id': 1}, callback),
    send: ['getSubscriptions', (results, callback) => {
      const manifest = {};
      async.each(results.getSubscriptions, (record, callback) => {
        const subscriptionId = record.subscription.id;
        api.subscriptions.send(actor, subscriptionId, options, err => {
          if(err) {
            manifest[subscriptionId] = {
              result: 'error',
              error: err
            };
            // TODO: should any 4xx cause a removal?
            if(options.removeBadSubscriptions &&
              err instanceof BedrockError && err.name === 'ProtocolError' &&
              (err.details.httpStatusCode === 400 ||
              err.details.httpStatusCode === 401 ||
              err.details.httpStatusCode === 404 ||
              err.details.httpStatusCode === 410)) {
              // attempt to remove subscription and ignore error
              return api.subscriptions.remove(
                actor, subscriptionId, err => callback());
            }
          } else {
            manifest[subscriptionId] = {
              result: 'success'
            };
          }
          callback();
        });
      }, err => callback(err, manifest));
    }]
  }, (err, results) => callback(err, results.send));
};

function createPushRequest(subscription, vapidKey, email, options) {
  let {payload = null} = options;

  // auto convert payload to JSON
  if(payload && typeof payload === 'object' &&
    !(payload instanceof Buffer)) {
    payload = JSON.stringify(payload);
  }

  // JWT expiration must be 24 hours or less in seconds
  const TIME_IN_24_HOURS = Math.floor(Date.now() / 1000) + 43200;
  const ttl = ('ttl' in options) ? options.ttl : DEFAULT_PUSH_MESSAGE_TTL;
  return webpush.generateRequestDetails(
    subscription.pushToken,
    payload, {
      vapidDetails: {
        subject: 'mailto: ' + email,
        publicKey: vapidKey.publicKeyBase64Url,
        privateKey: vapidKey.privateKeyBase64Url
      },
      TTL: ttl
    });
}
