import schema from './scenario.schema.json';
import { createValidator } from './validate-core.js';

export { schema };
export const validateScenarioText = createValidator(schema);
