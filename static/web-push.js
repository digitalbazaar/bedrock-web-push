/*
 * Bedrock Web Push Web App helper script.
 *
 * Copyright (c) 2017 Digital Bazaar, Inc. All rights reserved.
 */
/* global fetch */
(function() {

'use strict';

if(!global.bedrock) {
  global.bedrock = {};
}

var api = global.bedrock.webPush = {};

/**
 * Subscribe a service worker registration for push messages.
 *
 * This method will ensure the subscription is up-to-date with the server.
 *
 * @param registration the service worker registration.
 * @param options the options to use:
 *          baseUrl the base URL for the bedrock web-push API.
 *          serviceName the name of the service to subscribe for.
 *          label a label for the subscription.
 *          owner the owner (Identity) of the subscription.
 * @return a Promise that resolves to the pushToken on success.
 */
api.subscribe = function(registration, options) {
  if(!registration) {
    throw new TypeError('Service worker "registration" must be provided.');
  }
  if(!options || typeof options !== 'object') {
    throw new TypeError('"options" must be an object.');
  }
  if(typeof options.baseUrl !== 'string') {
    throw new TypeError('"options.baseUrl" must be a string.');
  }
  if(typeof options.serviceName !== 'string') {
    throw new TypeError('"options.serviceName" must be a string.');
  }
  if(typeof options.label !== 'string') {
    throw new TypeError('"options.label" must be a string.');
  }
  if(typeof options.owner !== 'string') {
    throw new TypeError('"options.owner" must be a string.');
  }

  var pm = registration.pushManager;
  if(!pm) {
    return Promise.reject(new Error('Push is not supported.'));
  }

  return getVapidKey(options.baseUrl, options.serviceName)
    .then(function(vapidKey) {
      return getValidSubscription(pm, vapidKey, options);
    });
};

/**
 * Unsubscribe a service worker registration from push messages.
 *
 * This method will attempt to remove the subscription from the server.
 *
 * @param registration the service worker registration.
 * @param options the options to use:
 *          baseUrl the base URL for the bedrock web-push API.
 * @return a Promise that resolves to the subscription.
 */
api.unsubscribe = function(registration, options) {
  if(!registration) {
    throw new TypeError('Service worker "registration" must be provided.');
  }
  if(!options || typeof options !== 'object') {
    throw new TypeError('"options" must be an object.');
  }
  if(typeof options.baseUrl !== 'string') {
    throw new TypeError('"options.baseUrl" must be a string.');
  }

  var pm = registration.pushManager;
  if(!pm) {
    return Promise.reject(new Error('Push is not supported.'));
  }

  return pm.getSubscription().then(function(pushToken) {
    var url = options.baseUrl + '/subscriptions?endpoint=' +
      encodeURIComponent(pushToken.endpoint);
    return fetch(url).then(function(res) {
      if(!res.ok) {
        // assume subscription does not exist (will be removed later if
        // it did and there was an error)
        return null;
      }
      return res.json();
    }).then(function(subscription) {
      if(!subscription) {
        return;
      }
      return fetch(subscription.id, {method: 'DELETE'});
    }).catch(function(err) {
      // ignore error with deleting subscription on server
    }).then(function() {
      // unsubscribe from push service
      return pm.unsubscribe();
    });
  });
};

function getVapidKey(baseUrl, serviceName) {
  var url = baseUrl + '/vapid-keys/' + encodeURIComponent(serviceName);
  return fetch(url).then(function(res) {
    if(!res.ok) {
      return res.json().then(function(error) {
        throw new Error(error.message);
      });
    }
    return res.json();
  });
}

function getValidSubscription(pm, vapidKey, options) {
  return pm.getSubscription().then(function(pushToken) {
    if(!pushToken) {
      // not yet subscribed, get push token
      return pm.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          vapidKey.publicKeyBase64Url)
      });
    }
    return pushToken;
  }).then(function(pushToken) {
    if(!pushToken) {
      // error can't subscribe
      throw new Error('Could not subscribe to push service.');
    }
    // send subscription to server
    var subscription = {
      label: options.label,
      owner: options.owner,
      vapidKey: vapidKey.id,
      // device: ??
      pushToken: pushToken
    };
    return storeSubscription(options.baseUrl, subscription);
  });
}

function storeSubscription(baseUrl, subscription) {
  // try to add subscription
  return fetch(baseUrl + '/subscriptions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(subscription)
  }).then(function(res) {
    if(!res.ok) {
      if(res.status === 409) {
        // duplicate subscription; not an error
        return subscription.pushToken;
      }
      // TODO: implement more recoverable error handling
      return res.json().then(function(error) {
        throw new Error(error.message);
      });
    }
    return subscription.pushToken;
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = global.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for(let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

})();
