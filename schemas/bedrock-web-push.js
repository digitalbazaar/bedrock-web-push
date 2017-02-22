/*
 * Copyright (c) 2017 Digital Bazaar, Inc. All rights reserved.
 */
const subscription = require('./web-push-subscription');

const postSubscription = subscription();

module.exports.postInbox = () => postSubscription;
