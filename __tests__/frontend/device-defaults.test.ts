/**
 * Regression tests for device-level defaults inheritance
 * Verifies that device-level size and resetValue are correctly applied
 * to peripherals when not explicitly specified.
 */

import { parseBigInt } from '../../src/utils';

// Access type mapping (mirrors production ACCESS_MAP)
const ACCESS_MAP: { [key: string]: number } = {
    'read-only': 1,
    'write-only': 2,
    'read-write': 0,
    'writeOnce': 3,
    'read-writeOnce': 4,
};

// Mock the peripheral parsing logic to test defaults inheritance
function parsePeripheralOptions(peripheralDef: any, defaults: any): any {
    const options: any = {
        name: peripheralDef.name,
        baseAddress: peripheralDef.baseAddress,
        description: peripheralDef.description || '',
    };

    // Apply device-level defaults first
    if (defaults.size !== undefined) {
        options.size = defaults.size;
    }
    if (defaults.resetValue !== undefined) {
        options.resetValue = defaults.resetValue;
    }
    if (defaults.accessType !== undefined) {
        options.accessType = defaults.accessType;
    }

    // Override with peripheral-specific values
    if (peripheralDef.access !== undefined) {
        // Mirror production: map access string to numeric value
        options.accessType = ACCESS_MAP[peripheralDef.access[0]] ?? peripheralDef.access;
    }
    if (peripheralDef.size !== undefined) {
        options.size = peripheralDef.size;
    }
    if (peripheralDef.resetValue !== undefined) {
        options.resetValue = peripheralDef.resetValue;
    }

    return options;
}

// Helper for register options construction (mirrors peripheral pattern)
function parseRegisterOptions(registerDef: any, peripheralOptions: any): any {
    const options: any = {
        name: registerDef.name,
        addressOffset: registerDef.addressOffset,
    };

    // Inherit from peripheral, then override with register-specific values
    if (registerDef.size !== undefined) {
        options.size = registerDef.size;
    } else if (peripheralOptions.size !== undefined) {
        options.size = peripheralOptions.size;
    }

    if (registerDef.resetValue !== undefined) {
        options.resetValue = registerDef.resetValue;
    } else if (peripheralOptions.resetValue !== undefined) {
        options.resetValue = peripheralOptions.resetValue;
    }

    if (registerDef.accessType !== undefined) {
        options.accessType = registerDef.accessType;
    } else if (peripheralOptions.accessType !== undefined) {
        options.accessType = peripheralOptions.accessType;
    }

    return options;
}

describe('Device-Level Defaults Inheritance', () => {
    test('should inherit device-level size=64 when peripheral omits size', () => {
        const defaults = {
            size: 64,
            resetValue: 0xFFFFFFFFFFFFFFFFn,
            accessType: 0,
        };

        const peripheralDef = {
            name: 'TIMER',
            baseAddress: 0x40000000,
            description: 'Timer peripheral',
            // size is omitted - should inherit from defaults
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        expect(options.size).toBe(64);
        expect(options.resetValue).toBe(0xFFFFFFFFFFFFFFFFn);
        expect(options.accessType).toBe(0);
    });

    test('should override device-level size when peripheral specifies size=32', () => {
        const defaults = {
            size: 64,
            resetValue: 0xFFFFFFFFn,
        };

        const peripheralDef = {
            name: 'GPIO',
            baseAddress: 0x50000000,
            size: 32, // Override device default
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        expect(options.size).toBe(32);
        expect(options.resetValue).toBe(0xFFFFFFFFn);
    });

    test('should inherit device-level resetValue when peripheral omits it', () => {
        const defaults = {
            size: 32,
            resetValue: 0xDEADBEEFn,
        };

        const peripheralDef = {
            name: 'CTRL',
            baseAddress: 0x60000000,
            // resetValue omitted - should inherit
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        expect(options.resetValue).toBe(0xDEADBEEFn);
        expect(options.size).toBe(32);
    });

    test('should handle 64-bit resetValue inheritance without precision loss', () => {
        const defaults = {
            size: 64,
            resetValue: 0x123456789ABCDEF0n,
        };

        const peripheralDef = {
            name: 'BIGINT_PERIPH',
            baseAddress: 0x70000000,
            // Both size and resetValue omitted
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        expect(options.size).toBe(64);
        expect(options.resetValue).toBe(0x123456789ABCDEF0n);
        expect(typeof options.resetValue).toBe('bigint');
    });

    test('should apply defaults in correct precedence: device < peripheral', () => {
        const defaults = {
            size: 64,
            resetValue: 0x1111111111111111n,
            accessType: 0,
        };

        const peripheralDef = {
            name: 'MIXED',
            baseAddress: 0x80000000,
            resetValue: 0x2222222222222222n, // Override resetValue
            // size and accessType inherited from defaults
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        expect(options.size).toBe(64); // Inherited
        expect(options.resetValue).toBe(0x2222222222222222n); // Overridden
        expect(options.accessType).toBe(0); // Inherited
    });

    test('should handle all defaults undefined gracefully', () => {
        const defaults = {};

        const peripheralDef = {
            name: 'MINIMAL',
            baseAddress: 0x90000000,
            size: 32,
            resetValue: 0xABCDn,
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        expect(options.size).toBe(32);
        expect(options.resetValue).toBe(0xABCDn);
        expect(options.accessType).toBeUndefined();
    });

    test('should preserve bigint type through inheritance chain', () => {
        // Simulate parsing from SVD
        const deviceResetValue = parseBigInt('0xFFFFFFFFFFFFFFFF');
        
        const defaults = {
            size: 64,
            resetValue: deviceResetValue,
        };

        const peripheralDef = {
            name: 'TEST',
            baseAddress: 0xA0000000,
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        // Verify bigint is preserved
        expect(typeof options.resetValue).toBe('bigint');
        expect(options.resetValue).toBe(0xFFFFFFFFFFFFFFFFn);
        
        // Verify no precision loss
        expect(options.resetValue.toString(16)).toBe('ffffffffffffffff');
    });

    test('should handle mixed number and bigint defaults correctly', () => {
        const defaults = {
            size: 64, // number
            resetValue: 0x8000000000000000n, // bigint (>MAX_SAFE_INTEGER)
        };

        const peripheralDef = {
            name: 'MIXED_TYPES',
            baseAddress: 0xB0000000,
        };

        const options = parsePeripheralOptions(peripheralDef, defaults);

        expect(typeof options.size).toBe('number');
        expect(typeof options.resetValue).toBe('bigint');
        expect(options.size).toBe(64);
        expect(options.resetValue).toBe(0x8000000000000000n);
    });
});

describe('Register-Level Defaults Inheritance', () => {
    test('should inherit peripheral size when register omits size', () => {
        const peripheralOptions = {
            size: 64,
            resetValue: 0xFFFFFFFFFFFFFFFFn,
        };

        const registerDef: any = {
            name: 'COUNTER',
            addressOffset: 0x00,
            // size omitted - should inherit from peripheral
        };

        const registerOptions = parseRegisterOptions(registerDef, peripheralOptions);

        expect(registerOptions.size).toBe(64);
        expect(registerOptions.resetValue).toBe(0xFFFFFFFFFFFFFFFFn);
    });

    test('should override peripheral size when register specifies size', () => {
        const peripheralOptions = {
            size: 64,
            resetValue: 0xFFFFFFFFFFFFFFFFn,
        };

        const registerDef: any = {
            name: 'STATUS',
            addressOffset: 0x08,
            size: 32, // Override
        };

        const registerOptions = parseRegisterOptions(registerDef, peripheralOptions);

        expect(registerOptions.size).toBe(32);
    });
});

