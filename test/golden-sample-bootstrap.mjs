import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
let ordinal = 0;
crypto.randomUUID = () => {
  const hash = crypto.createHash('sha256').update(`golden/v1:${ordinal++}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
};
syncBuiltinESMExports();
// Preserve real time intervals/liveness checks while fixing the wall-clock origin.
const ActualDate = Date, start = ActualDate.now(), epoch = 1792368000000;
class GoldenDate extends ActualDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + ActualDate.now() - start); }
  static now() { return epoch + ActualDate.now() - start; }
}
globalThis.Date = GoldenDate;
process.env.TZ = 'UTC';
