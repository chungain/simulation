import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const standardText = () => readFileSync(`${root}scenarios/standard-factory.json`, 'utf8');
export const standard = () => JSON.parse(standardText());
export const buyerVendorText = () => readFileSync(`${root}scenarios/buyer-vendor.json`, 'utf8');
export const buyerVendor = () => JSON.parse(buyerVendorText());
