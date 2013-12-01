/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global describe,it,require */

var
Verifier = require('./lib/verifier.js'),
should = require('should'),
request = require('request');

describe('wrong content type test', function() {
  var verifier = new Verifier();

  it('test servers should start', function(done) {
    verifier.start(done);
  });

  it('should fail to verify when content-type is unsupported', function(done) {
    request({
      method: 'post',
      url: verifier.url(),
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify({
        audience: "http://example.com"
      })
    }, function(err, r) {
      should.not.exist(err);
      (r.statusCode).should.equal(415);
      (function() {
        r.body = JSON.parse(r.body);
      }).should.not.throw();
      (r.body.status).should.equal('failure');
      (r.body.reason).should.startWith('Unsupported Content-Type: text/plain');
      done();
    });
  });

  it('test servers should stop', function(done) {
    verifier.stop(done);
  });
});
