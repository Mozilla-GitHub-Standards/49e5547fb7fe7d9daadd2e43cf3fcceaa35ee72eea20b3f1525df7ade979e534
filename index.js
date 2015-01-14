'use strict';

var FXOSSimulators = require('node-firefox-find-simulators');
var Q = require('q');
var net = require('net');
var FXPorts = require('node-firefox-ports');
var spawn = require('child_process').spawn;
var FirefoxClient = require('firefox-client');
var portfinder = require('portfinder');
var fs = require('fs');
var __ = require('underscore');


module.exports = startB2G;

function portIsReady(port, cb) {
  var defer = Q.defer();

  function ping() {
    var sock = new net.Socket();
    sock
      .on('connect', function() {
        defer.resolve();
        sock.destroy();
      })
      .on('error', function(e) {
        if (e && e.code !== 'ECONNREFUSED') {
          throw e;
        }
        sock.destroy();
        setTimeout(function() {
          ping(defer);
        }, 1000);
      })
      .connect(port,'localhost');
  }
  ping();
  return defer.promise;
}

function commandB2G(opts) {
  var defer = Q.defer();

  var childOptions = { stdio: ['ignore', 'ignore', 'ignore'] };

  if (opts.exit) {
    childOptions.detached = true;
  }

  if (opts.verbose) {
    childOptions.stdio = [process.stdin,  process.stdout, process.stderr];
  }

  if (opts.stdin) {
    childOptions.stdio[0] = fs.openSync(opts.stdin, 'a');
  }
  if (opts.stdout) {
    childOptions.stdio[1] = fs.openSync(opts.stdout, 'a');
  }
  if (opts.stderr) {
    childOptions.stdio[2] = fs.openSync(opts.stderr, 'a');
  }

  var simProcess = spawn(
    opts.bin,
    ['-profile', opts.profile, '-start-debugger-server', opts.port, '-no-remote'],
    childOptions
  );

  if (!opts.exit) {
    // From https://www.exratione.com/2013/05/die-child-process-die/
    process.once('exit', function() {
      simProcess.kill('SIGTERM');
    });

    process.once('uncaughtException', function(error) {
      if (process.listeners('uncaughtException').length === 0) {
        simProcess.kill('SIGTERM');
        throw error;
      }
    });
  }

  if (opts.exit) {
    simProcess.unref();
  }
  defer.resolve(simProcess);
  return defer.promise;
}

function createClient(simulator) {
  var deferred = Q.defer();
  var client = new FirefoxClient();
  client.connect(simulator.port, function(err) {
    if (err) {
      deferred.reject(err);
    }
    simulator.client = client;
    deferred.resolve(simulator);
  });
  return deferred.promise;
}

function runB2G(opts) {
  var commandReady = commandB2G(opts);
  var portReady = commandReady.then(portIsReady.bind(null, opts.port));
  return portReady.then(function() {
    return commandReady;
  });
}


function findPaths(opts) {
  return Q.nfcall(FXOSSimulators, opts)
    .then(function(b2gs) {
      if (!b2gs || !b2gs.length) {
        throw new Error ('No simulator found on your machine');
      }
      var latestB2G = b2gs[b2gs.length - 1];
      return latestB2G;
    });
}

function startB2G(opts, callback) {

  if (typeof opts === 'function') {
    callback = opts;
  }
  opts = __.clone(opts) || {};

  /* Options */

  if (opts.force) {
    new FXPorts({ b2g: true }, function(err, instances) {
      instances.forEach(function(instance) {
        process.kill(instance.pid);
      });
    });
  }

  /* Promises */

  // Make sure we have bin, profile and port
  var pathsReady = (opts.bin && opts.profile) ? { bin: opts.bin, opts: opts.profile } : findPaths(opts);
  var portReady = opts.port || Q.ninvoke(portfinder, 'getPort', opts);
  var optsReady = Q.all([pathsReady, portReady])
    .spread(function(paths, port) {
      // Cloning bevause opts should be unaltered
      var simulator = __.clone(opts);
      simulator.bin = paths.bin;
      simulator.profile = paths.profile;
      simulator.port = port;
      if (paths && paths.release) {
        simulator.release = paths.release;
      }
      else if (opts.bin && opts.profile && opts.release.length === 1) {
        simulator.release = simulator.release[0];
      }

      return simulator;
    });

  var runReady = optsReady.then(runB2G);

  return Q.all([optsReady, runReady])
    .spread(function(opts, simProcess) {
      opts.process = simProcess;
      opts.pid = simProcess.pid;
      return opts;
    })
    .then(function(simulator) {
      return opts.connect ? createClient(simulator) : simulator;
    })
    .nodeify(callback);

}

process.once('SIGTERM', function() {
  process.exit(0);
});
process.once('SIGINT', function() {
  process.exit(0);
});
