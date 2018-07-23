#!/usr/bin/env node

var ansi      = require('ansi'),
    async     = require('async'),
    bigInt    = require('big-integer'),
    chronolog = require('chronolog'),
    clone     = require('clone'),
    config    = require('../config'),
    filesize  = require('filesize'),
    fs        = require('fs'),
    graphite  = require('graphite'),
    os        = require('os'),
    path      = require('path'),
    split     = require('split'),
    statvfs   = require('statvfs'),
    sysconf   = require('sysconf'),
    tty       = require('tty');

var hostname   = os.hostname().replace( /\./g, '_' ),
    cursor     = (tty.isatty(1) ? ansi(process.stdout) : null),
    errorScore = 0,
    lastDate   = new Date,
    lastCPU    = {},
    lastNet    = {},
    clockHz    = sysconf.get(sysconf._SC_CLK_TCK),
    log        = chronolog(console),
    timeoutId  = null;

var graphiteDebug = config.graphite && config.graphite.debug;
var graphiteClient = (
    !graphiteDebug &&
    config.graphite &&
    config.graphite.carbon &&
    graphite.createClient(config.graphite.carbon.url)
);

function getMetrics(cb) {
    async.parallel({

        loadavg : function(nextMetric) {
            fs.readFile('/proc/loadavg', function(err, load) {
                if (err) {
                    nextMetric(err);
                } else {
                    load = load.toString().split(/\s+/);
                    load[3] = load[3].split('/');
                    nextMetric(null, {
                        '1min'         : load[0],
                        '5min'         : load[1],
                        '15min'        : load[2],
                        sched_runnable : load[3][0],
                        sched_existing : load[3][1],
                        last_pid       : load[4]
                    });
                }
            });
        },

        cpu : function(nextMetric) {
            var cpuMetrics = {},
                cpuCount   = 0;
            fs.createReadStream('/proc/stat')
                .pipe(split())
                .on('data', function(line) {
                    var arr  = line.split(/\s+/),
                        name = arr[0],
                        now  = new Date / 1000 * clockHz,
                        last = lastCPU[name] || {};

                    if (/^cpu\d*$/.test(name)) {

                        if (name != 'cpu') {
                            cpuCount++;
                        }
                        var cpu = {};
                        for (var i = 0; i < arr.length; i++) {
                            var field = config.cpuFields[i];
                            if (field) {
                                cpu[field] = (last._date
                                    ? (arr[i] - last[field]) / (now - last._date)
                                    : +arr[i]);
                                last[field] = +arr[i];
                            }
                        }
                        if (last._date) {
                            cpuMetrics[name] = cpu;
                        }
                        last._date = now;
                        lastCPU[name] = last;

                    } else if (name == 'intr' || name == 'ctxt' || name == 'processes') {

                        if (last._date) {
                            cpuMetrics[name] = (arr[1] - last.value) / (now - last._date);
                        }
                        last._date = now;
                        last.value = +arr[1];
                        lastCPU[name] = last;

                    } else if (name == 'procs_running' || name == 'procs_blocked') {

                        cpuMetrics[name] = +arr[1];

                    }
                })
                .on('end', function() {
                    for (var k in cpuMetrics.cpu) {
                        cpuMetrics.cpu[k] /= cpuCount;
                    }
                    for (var k in cpuMetrics) {
                        cpuMetrics[k]._usage =
                            1 - cpuMetrics[k].idle - cpuMetrics[k].iowait;
                    }
                    nextMetric(null, cpuMetrics);
                });
        },

        mem : function(nextMetric) {
            var memMetrics = {};
            fs.createReadStream('/proc/meminfo')
                .pipe(split())
                .on('data', function(line) {
                    var arr = line.split(/[:\s]+/);
                    if (config.memInfoInclude[arr[0]]) {
                        if (arr[2] != 'kB') {
                            log.warn('Expected kB in meminfo line: ' + line);
                        }
                        memMetrics[arr[0]] = arr[1];
                    }
                })
                .on('end', function() {
                    nextMetric(null, memMetrics);
                });
        },

        fs : function(nextMetric) {
            var fsMetrics = {};
            async.forEach(Object.keys(config.fs), function(fsName, nextFs) {
                statvfs(config.fs[fsName], function(err, f) {
                    if (!err) {
                        // frsize is "fragment size" or actual block size;
                        // bsize is *preferred* block size
                        fsMetrics[fsName] = {
                            size      : f.frsize * f.blocks,
                            free_root : f.frsize * f.bfree,
                            free      : f.frsize * f.bavail
                        };
                    }
                    nextFs(err);
                });
            }, function(err) {
                nextMetric(err, fsMetrics);
            });
        },

        net : function(nextMetric) {
            var netMetrics = {};
            async.forEach(config.net, function(iface, nextIface) {
                netMetrics[iface] = {};
                async.forEach(['rx', 'tx'], function(stat, nextStat) {
                    fs.readFile(
                        '/sys/class/net/' + iface
                        + '/statistics/' + stat + '_bytes',
                        'utf8',
                        function(err, data) {
                            var now, value, last;

                            if (err) {
                                return nextStat(err);
                            }

                            if (!lastNet[iface]) {
                                lastNet[iface] = {};
                            }
                            now   = new Date / 1000;
                            value = bigInt(data.trim());
                            last  = lastNet[iface][stat];
                            if (last) {
                                netMetrics[iface][stat + '_bytes_per_sec'] =
                                    value.subtract(last.value).toJSNumber()
                                    / (now - last.date);
                            }
                            lastNet[iface][stat] = {
                                date  : now,
                                value : value,
                            };
                            nextStat(null);
                        }
                    );
                }, function(err) {
                    nextIface(err);
                });
            }, function(err) {
                nextMetric(err, netMetrics);
            });
        },

    }, function(err, metrics) {
        cb(err, metrics);
    });
}

function sendMetrics(metrics, cb) {
    var data = {},
        prefix = '';

    if (config.graphite && config.graphite.prefix) {
        prefix = config.graphite.prefix.replace('{hostname}', hostname);
    }

    if (prefix) {
        data[prefix] = metrics;
    } else {
        data = metrics;
    }

    if (graphiteDebug) {
        var dataFlattened = graphite.flatten(data);
        Object.keys(dataFlattened).forEach(function(metric) {
            console.log('%s: %s', metric, dataFlattened[metric]);
        });
        cb(null);
    } else if (graphiteClient) {
        graphiteClient.write(data, function(err) {
            cb(err);
        });
    } else {
        cb(null);
    }
}

function summarize(metrics) {
    var summary = Object.keys(metrics).sort().map(function(k) {
        switch (k) {
            case 'loadavg':
                return 'load=' + [
                    metrics.loadavg['1min'],
                    metrics.loadavg['5min'],
                    metrics.loadavg['15min']
                ].join('/');

            case 'cpu':
                var cpu = metrics.cpu.cpu;
                if (cpu) {
                    cpu = '   ' + Math.round(100 * cpu._usage);
                    return 'cpu=' + cpu.substring(cpu.length - 3) + '%';
                } else {
                    return 'cpu=????';
                }

            case 'mem':
                return 'mem=' + filesize(metrics.mem.MemFree * 1024, { unix : true });

            case 'fs':
                var free = Object.keys(metrics.fs).reduce(function(sum, f) {
                    return sum + metrics.fs[f].free;
                }, 0);
                return 'df=' + filesize(free, { unix : true });

            case 'net':
                var speed = Object.keys(metrics.net).reduce(function(sum, iface) {
                    return {
                        rx: sum.rx + (metrics.net[iface].rx_bytes_per_sec || 0),
                        tx: sum.tx + (metrics.net[iface].tx_bytes_per_sec || 0),
                    };
                }, { rx : 0, tx : 0 });
                return (
                    filesize(speed.rx, { unix : true }) + 'u/' +
                    filesize(speed.tx, { unix : true }) + 'd'
                );

            default:
                throw new Error('Unhandled metric type in summarize(): ' + k);
        }
    }).join(' ');

    var maxLen = 64;
    if (summary.length > maxLen) {
        summary = summary.substring(0, maxLen - 3) + '...';
    }

    return summary;
}

function loop() {
    function nextLoop() {
        lastDate = new Date;
        var ms = +lastDate % 1000;
        // Sometimes we get multiple errors, which means we need to avoid
        // running multiple loops at the same time.  This is probably a bug in
        // 'graphite' but it seems easiest to just avoid it here.
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(loop, 1000 - ms);
    }

    function error(err) {
        log.error('Error: ' + err.message);
        errorScore += 10;
        if (errorScore < 50) {
            nextLoop();
        } else {
            log.error('Too many errors - exiting.');
        }
    }

    getMetrics(function(err, metrics) {
        if (err) {

            error(err);

        } else {

            if (errorScore > 0) {
                errorScore--;
            }

            if (graphiteDebug) {
                console.log(chronolog(summarize(metrics)));
            } else if (cursor) {
                if (lastDate.getSeconds() == 0) {
                    console.log();
                }
                cursor
                    .up()
                    .horizontalAbsolute(0)
                    .eraseLine()
                    .write(chronolog(summarize(metrics) + '\n'));
            }

            sendMetrics(metrics, function(err) {
                if (err) {
                    error(err);
                } else {
                    nextLoop();
                }
            });

        }
    });
}

console.log();

loop();
