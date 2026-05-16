function __capnweb_mismatch(path, expected, value) {
    return { path, expected, actual: __capnweb_actualKind(value), value };
}
function __capnweb_missing(path, expected) {
    return { path, expected, actual: "missing", value: undefined };
}
function __capnweb_makeValidationError(prefix, failure) {
    let where = failure.path.length > 0 ? failure.path.join(".") : "value";
    let err = new TypeError(prefix + ": " + where + ": expected " + failure.expected + ", got " + failure.actual);
    err.rpcValidation = failure;
    return err;
}
function __capnweb_actualKind(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (value instanceof Date)
        return "Date";
    if (value instanceof RegExp)
        return "RegExp";
    if (value instanceof Error)
        return "Error";
    if (typeof value === "object") {
        let ctor = value.constructor;
        if (ctor && ctor.name && ctor.name !== "Object")
            return ctor.name;
        return "object";
    }
    return typeof value;
}
function __capnweb_validate_0(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_2(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_3(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_1(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return __capnweb_mismatch(path, "{ id: string, name: string }", value);
    let record = value;
    if (!Object.prototype.hasOwnProperty.call(record, "id"))
        return __capnweb_missing([...path, "id"], "string");
    {
        let failure = __capnweb_validate_2(record["id"], [...path, "id"], options);
        if (failure)
            return failure;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "name"))
        return __capnweb_missing([...path, "name"], "string");
    {
        let failure = __capnweb_validate_3(record["name"], [...path, "name"], options);
        if (failure)
            return failure;
    }
    return undefined;
}
function __capnweb_validate_6(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_7(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_5(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return __capnweb_mismatch(path, "{ id: string, name: string }", value);
    let record = value;
    if (!Object.prototype.hasOwnProperty.call(record, "id"))
        return __capnweb_missing([...path, "id"], "string");
    {
        let failure = __capnweb_validate_6(record["id"], [...path, "id"], options);
        if (failure)
            return failure;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "name"))
        return __capnweb_missing([...path, "name"], "string");
    {
        let failure = __capnweb_validate_7(record["name"], [...path, "name"], options);
        if (failure)
            return failure;
    }
    return undefined;
}
function __capnweb_validate_9(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_path_8(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_9(value, path, options);
    return undefined;
}
function __capnweb_validate_11(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_path_10(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_11(value, path, options);
    return undefined;
}
function __capnweb_validate_path_4(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_5(value, path, options);
    switch (path[offset]) {
        case "id":
            return __capnweb_validate_path_8(path, value, offset + 1, options);
        case "name":
            return __capnweb_validate_path_10(path, value, offset + 1, options);
        default: return undefined;
    }
}
function __capnweb_validate_12(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_14(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_15(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_13(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return __capnweb_mismatch(path, "{ id: string, bio: string }", value);
    let record = value;
    if (!Object.prototype.hasOwnProperty.call(record, "id"))
        return __capnweb_missing([...path, "id"], "string");
    {
        let failure = __capnweb_validate_14(record["id"], [...path, "id"], options);
        if (failure)
            return failure;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "bio"))
        return __capnweb_missing([...path, "bio"], "string");
    {
        let failure = __capnweb_validate_15(record["bio"], [...path, "bio"], options);
        if (failure)
            return failure;
    }
    return undefined;
}
function __capnweb_validate_18(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_19(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_17(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return __capnweb_mismatch(path, "{ id: string, bio: string }", value);
    let record = value;
    if (!Object.prototype.hasOwnProperty.call(record, "id"))
        return __capnweb_missing([...path, "id"], "string");
    {
        let failure = __capnweb_validate_18(record["id"], [...path, "id"], options);
        if (failure)
            return failure;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "bio"))
        return __capnweb_missing([...path, "bio"], "string");
    {
        let failure = __capnweb_validate_19(record["bio"], [...path, "bio"], options);
        if (failure)
            return failure;
    }
    return undefined;
}
function __capnweb_validate_21(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_path_20(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_21(value, path, options);
    return undefined;
}
function __capnweb_validate_23(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_path_22(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_23(value, path, options);
    return undefined;
}
function __capnweb_validate_path_16(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_17(value, path, options);
    switch (path[offset]) {
        case "id":
            return __capnweb_validate_path_20(path, value, offset + 1, options);
        case "bio":
            return __capnweb_validate_path_22(path, value, offset + 1, options);
        default: return undefined;
    }
}
function __capnweb_validate_24(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_26(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_25(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    if (!Array.isArray(value))
        return __capnweb_mismatch(path, "string[]", value);
    for (let i = 0; i < value.length; i++) {
        let failure = __capnweb_validate_26(value[i], [...path, "[" + i + "]"], options);
        if (failure)
            return failure;
    }
    return undefined;
}
function __capnweb_validate_29(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_28(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    if (!Array.isArray(value))
        return __capnweb_mismatch(path, "string[]", value);
    for (let i = 0; i < value.length; i++) {
        let failure = __capnweb_validate_29(value[i], [...path, "[" + i + "]"], options);
        if (failure)
            return failure;
    }
    return undefined;
}
function __capnweb_validate_31(value, path, options) {
    if (options?.isRpcPlaceholder?.(value))
        return undefined;
    return typeof value === "string" ? undefined : __capnweb_mismatch(path, "string", value);
}
function __capnweb_validate_path_30(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_31(value, path, options);
    return undefined;
}
function __capnweb_validate_path_27(path, value, offset = 0, options) {
    if (offset >= path.length)
        return __capnweb_validate_28(value, path, options);
    return __capnweb_validate_path_30(path, value, offset + 1, options);
}
export const validators = {
    "Api": {
        "authenticate": {
            args(args, options) {
                if (args.length < 1 || args.length > 1) {
                    throw new TypeError("Api.authenticate expected 1 argument(s), got " + args.length);
                }
                {
                    let failure = __capnweb_validate_0(args[0], ["sessionToken"], options);
                    if (failure)
                        throw __capnweb_makeValidationError("Api.authenticate", failure);
                }
            },
            returns(value) {
                let failure = __capnweb_validate_1(value, []);
                if (failure)
                    throw __capnweb_makeValidationError("Api.authenticate return", failure);
            },
            returnsPath(path, value) {
                let failure = __capnweb_validate_path_4(path, value);
                if (failure)
                    throw __capnweb_makeValidationError("Api.authenticate return", failure);
            },
        },
        "getUserProfile": {
            args(args, options) {
                if (args.length < 1 || args.length > 1) {
                    throw new TypeError("Api.getUserProfile expected 1 argument(s), got " + args.length);
                }
                {
                    let failure = __capnweb_validate_12(args[0], ["userId"], options);
                    if (failure)
                        throw __capnweb_makeValidationError("Api.getUserProfile", failure);
                }
            },
            returns(value) {
                let failure = __capnweb_validate_13(value, []);
                if (failure)
                    throw __capnweb_makeValidationError("Api.getUserProfile return", failure);
            },
            returnsPath(path, value) {
                let failure = __capnweb_validate_path_16(path, value);
                if (failure)
                    throw __capnweb_makeValidationError("Api.getUserProfile return", failure);
            },
        },
        "getNotifications": {
            args(args, options) {
                if (args.length < 1 || args.length > 1) {
                    throw new TypeError("Api.getNotifications expected 1 argument(s), got " + args.length);
                }
                {
                    let failure = __capnweb_validate_24(args[0], ["userId"], options);
                    if (failure)
                        throw __capnweb_makeValidationError("Api.getNotifications", failure);
                }
            },
            returns(value) {
                let failure = __capnweb_validate_25(value, []);
                if (failure)
                    throw __capnweb_makeValidationError("Api.getNotifications return", failure);
            },
            returnsPath(path, value) {
                let failure = __capnweb_validate_path_27(path, value);
                if (failure)
                    throw __capnweb_makeValidationError("Api.getNotifications return", failure);
            },
        }
    }
};
