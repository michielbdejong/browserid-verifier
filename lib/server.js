#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

require('../lib/baseExceptions').addExceptionHandler();

const
_ = require('underscore'),
util = require("util"),
path = require('path'),
url = require('url'),
fs = require('fs'),
express = require('express'),
computecluster = require('compute-cluster'),
heartbeat = require('../lib/heartbeat'),
logger = require('../lib/logging/logging').logger,
config = require('../lib/configuration'),
shutdown = require('../lib/shutdown'),
booleanQuery = require('../lib/boolean-query'),
toobusy = require('../lib/busy_middleware.js'),
statsd = require("../lib/logging/middleware/statsd");

logger.info("verifier server starting up");

if (config.get('env') === 'production') {
  logger.info('node.js version: ' + process.version + ' at ' + process.execPath);
  logger.info('configuration: ', JSON.stringify(JSON.parse(config.toString())));
}

var app = express.createServer();

// setup health check / heartbeat (before logging)
heartbeat.setup(app);

app.use(toobusy);

// request to logger, dev formatted which omits personal data in the requests
app.use(express.logger({
  format: config.get('express_log_format'),
  stream: {
    write: function(x) {
      logger.info(typeof x === 'string' ? x.trim() : x);
    }
  }
}));

// limit all content bodies to 10kb, at which point we'll forcefully
// close down the connection.
app.use(express.limit("10kb"));

app.use(statsd());
app.use(express.bodyParser());
app.use(booleanQuery);

try {
  // explicitly relay VAR_PATH to children
  process.env['VAR_PATH'] = config.get('var_path');

  // allocate a compute cluster
  var cc = new computecluster({
    module: path.join(__dirname, "..", "lib", "verifier", "verifier-compute.js"),
    max_processes: config.get('max_compute_processes')
  }).on('error', function(e) {
    logger.error("error detected in verification computation process!  fatal: " + e.toString());
    setTimeout(function() { process.exit(1); }, 0);
  }).on('info', function(msg) {
    logger.info("(compute cluster): " + msg);
  }).on('debug', function(msg) {
    logger.debug("(compute cluster): " + msg);
  });
} catch(e) {
  process.stderr.write("can't allocate compute cluster: " + e + "\n");
  process.exit(1);
}

function doVerification(req, resp, next) {
  req.query = req.query || {};
  req.body = req.body || {};

  var assertion = req.query.assertion ? req.query.assertion : req.body.assertion;
  var audience = req.query.audience ? req.query.audience : req.body.audience;
  var forceIssuer = req.query.experimental_forceIssuer ? req.query.experimental_forceIssuer : req.body.experimental_forceIssuer;
  var allowUnverified = req.query.experimental_allowUnverified ? req.query.experimental_allowUnverified : req.body.experimental_allowUnverified;

  if (!(assertion && audience)) {
    // why couldn't we extract these guys?  Is it because the request parameters weren't encoded as we expect? GH-643
    const want_ct = [ 'application/x-www-form-urlencoded', 'application/json' ];
    var reason;
    try {
      var ct = req.headers['content-type'];
      if (ct.indexOf(';') != -1) ct = ct.substr(0, ct.indexOf(';'));
      if (want_ct.indexOf(ct) == -1) throw "wrong content type";
    } catch (e) {
      reason = "Content-Type expected to be one of: " + want_ct.join(", ");
      logger.info('verify', {
        result: 'failure',
        reason: reason,
        rp: audience
      });
      return resp.json({ status: "failure", reason: reason}, 415);
    }
    reason = "need assertion and audience";
    logger.info('verify', {
      result: 'failure',
      reason: reason,
      rp: audience
    });
    return resp.json({ status: "failure", reason: reason}, 400);
  }

  var startTime = new Date();
  cc.enqueue({
    assertion: assertion,
    audience: audience,
    forceIssuer: forceIssuer,
    allowUnverified: !!allowUnverified
  }, function (err, r) {
    var reqTime = new Date - startTime;
    logger.info('assertion_verification_time', reqTime);

    // consider "application" errors to be the same as harder errors
    if (!err && r && r.error) err = r.error;
    else if (!r || !r.success) err = "no response returned from child process";

    if (err) {
      logger.info("assertion_failure");
      resp.json({"status":"failure", reason: err});  //Could be 500 or 200 OK if invalid cert
      logger.info('verify', {
        result: 'failure',
        reason: err,
        rp: audience
      });
    } else {
      resp.json(_.extend(r.success, {
        status : "okay",
        audience : audience, // NOTE: we return the audience formatted as the RP provided it, not normalized in any way.
        expires : new Date(r.success.expires).valueOf()
      }));

      logger.info('verify', {
        result: 'success',
        rp: r.success.audience
      });
    }
  });
}

app.post('/verify', doVerification);
app.post('/', doVerification);

// shutdown nicely on signals
shutdown.handleTerminationSignals(app, function() {
  cc.exit();
  toobusy.shutdown();
});

var bindTo = config.get('bind_to');
app.listen(bindTo.port, bindTo.host, function(conn) {
  logger.info("running on http://" + app.address().address + ":" + app.address().port);
});
 