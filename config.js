var wd = process.cwd();
process.chdir(__dirname);
var config = module.exports = require('config');
process.chdir(wd);

if (!config.memInfoInclude) {
    config.memInfoInclude = {
        MemTotal     : true,
        MemFree      : true,
        Buffers      : true,
        Cached       : true,
        SwapCached   : true,
        Active       : true,
        Inactive     : true,
        SwapTotal    : true,
        SwapFree     : true,
        Mapped       : true,
        Slab         : true,
        SReclaimable : true,
        KernelStack  : true,
        PageTables   : true,
        VmallocTotal : true,
        VmallocUsed  : true,
        VmallocChunk : true,
    };
}

if (!config.cpuFields) {
    config.cpuFields = {
        1  : 'user',
        2  : 'nice',
        3  : 'system',
        4  : 'idle',
        5  : 'iowait',
        6  : 'irq',
        7  : 'softirq',
        8  : 'steal',
        9  : 'guest',
        10 : 'guest_nice',
    };
}

if (!config.fs) {
    console.warn("WARNING: Setting default fs config: { root: '/' }");
    config.fs = { root: '/' };
}

if (!Array.isArray(config.net)) {
    config.net = [];
}

if (config.graphite && config.graphite.debug) {
    console.warn("WARNING: Graphite debug mode - no live data will be sent");
}
if (!config.graphite || !config.graphite.carbon) {
    console.warn("WARNING: No graphite target configured");
}
