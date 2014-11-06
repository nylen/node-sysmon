var wd = process.cwd();
process.chdir(__dirname);
module.exports = require('config');
process.chdir(wd);

module.exports.memInfoInclude = {
    MemTotal     : true,
    MemFree      : true,
    Buffers      : true,
    Cached       : true,
    SwapCached   : true,
    Active       : true,
    SwapTotal    : true,
    SwapFree     : true,
    Mapped       : true,
    Slab         : true,
    SReclaimable : true,
    KernelStack  : true,
    PageTables   : true,
    VmallocTotal : true,
    VmallocUsed  : true,
    VmallocChunk : true
};

module.exports.cpuFields = {
    1  : 'user',
    2  : 'nice',
    3  : 'system',
    4  : 'idle',
    5  : 'iowait',
    6  : 'irq',
    7  : 'softirq',
    8  : 'steal',
    9  : 'guest',
    10 : 'guest_nice'
};
