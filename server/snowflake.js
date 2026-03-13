const EPOCH = 1704067200000n;

export class SnowflakeGenerator {
  constructor(workerId = 1, processId = 1) {
    this.workerId = BigInt(workerId & 0x1f);
    this.processId = BigInt(processId & 0x1f);
    this.increment = 0n;
    this.lastMs = 0n;
  }

  generate() {
    let now = BigInt(Date.now());
    if (now < this.lastMs) now = this.lastMs;

    if (now === this.lastMs) {
      this.increment = (this.increment + 1n) & 0xfffn;
      if (this.increment === 0n) {
        while (BigInt(Date.now()) <= now) {
        }
        now = BigInt(Date.now());
      }
    } else {
      this.increment = 0n;
    }

    this.lastMs = now;

    const timestampPart = (now - EPOCH) << 22n;
    const workerPart = this.workerId << 17n;
    const processPart = this.processId << 12n;
    const id = timestampPart | workerPart | processPart | this.increment;

    return id.toString();
  }
}

export function extractTimestampFromSnowflake(id) {
  const value = BigInt(id);
  return Number((value >> 22n) + EPOCH);
}
