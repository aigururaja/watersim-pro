/**
 * WaterSim Pro — stub driver factory
 *
 * Builds an honest stub: the protocol is listed (status 'stub') with full
 * configFields + addressHint so the UI can render its form, but createClient
 * throws a clear error naming the optional package that would make it real.
 * See backend/src/plc/README.md for how to turn a stub into a working driver.
 */
'use strict';

function makeStubDriver({ protocol, label, configFields, addressHint, packageName }) {
  const notImplemented = () =>
    new Error(
      `${label} driver requires the optional '${packageName}' package — see backend/src/plc/README.md`
    );

  return {
    descriptor: { protocol, label, status: 'stub', configFields, addressHint },

    createClient(_config) {
      throw notImplemented();
    },

    async testConnection(_config = {}) {
      return { ok: false, message: notImplemented().message };
    },

    validateConfig(config = {}) {
      const errors = [];
      for (const f of configFields) {
        if (f.required && (config[f.key] === undefined || config[f.key] === null || config[f.key] === '')) {
          errors.push(`config.${f.key} is required`);
        }
      }
      return errors;
    },

    validateAddress(_address) {
      return null; // no local validation for stub protocols
    },
  };
}

module.exports = { makeStubDriver };
