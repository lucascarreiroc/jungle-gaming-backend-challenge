"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var MikroOrmCoreModule_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MikroOrmCoreModule = void 0;
const core_1 = require("@mikro-orm/core");
const common_1 = require("@nestjs/common");
const core_2 = require("@nestjs/core");
const middleware_helper_1 = require("./middleware.helper");
const mikro_orm_common_1 = require("./mikro-orm.common");
const mikro_orm_entities_storage_1 = require("./mikro-orm.entities.storage");
const mikro_orm_middleware_1 = require("./mikro-orm.middleware");
const mikro_orm_providers_1 = require("./mikro-orm.providers");
async function tryRequire(name) {
    try {
        return await Promise.resolve(`${name}`).then(s => __importStar(require(s)));
    }
    catch {
        return undefined; // ignore, optional dependency
    }
}
// TODO: provide the package name via some platform method, prefer that over the static map when available
const PACKAGES = {
    MongoDriver: '@mikro-orm/mongodb',
    MySqlDriver: '@mikro-orm/mysql',
    MsSqlDriver: '@mikro-orm/mssql',
    MariaDbDriver: '@mikro-orm/mariadb',
    PostgreSqlDriver: '@mikro-orm/postgresql',
    SqliteDriver: '@mikro-orm/sqlite',
    LibSqlDriver: '@mikro-orm/libsql',
    BetterSqliteDriver: '@mikro-orm/better-sqlite',
};
let MikroOrmCoreModule = MikroOrmCoreModule_1 = class MikroOrmCoreModule {
    constructor(options, moduleRef) {
        this.options = options;
        this.moduleRef = moduleRef;
    }
    static async forRoot(options) {
        const contextName = this.setContextName(options?.contextName);
        if (options?.driver && !contextName) {
            const packageName = PACKAGES[options.driver.name];
            const driverPackage = await tryRequire(packageName);
            if (driverPackage) {
                return {
                    module: MikroOrmCoreModule_1,
                    providers: [
                        { provide: mikro_orm_common_1.MIKRO_ORM_MODULE_OPTIONS, useValue: options || {} },
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName),
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName, driverPackage.MikroORM),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, core_1.EntityManager),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, driverPackage.EntityManager),
                    ],
                    exports: [
                        core_1.MikroORM,
                        core_1.EntityManager,
                        driverPackage.EntityManager,
                        driverPackage.MikroORM,
                    ],
                };
            }
        }
        const knex = await tryRequire('@mikro-orm/knex');
        const mongo = await tryRequire('@mikro-orm/mongodb');
        const em = await this.createEntityManager(options);
        if (em && !contextName) {
            const packageName = PACKAGES[em.getDriver().constructor.name];
            const driverPackage = await tryRequire(packageName);
            if (driverPackage) {
                return {
                    module: MikroOrmCoreModule_1,
                    providers: [
                        { provide: mikro_orm_common_1.MIKRO_ORM_MODULE_OPTIONS, useValue: options || {} },
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName),
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName, driverPackage.MikroORM),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, core_1.EntityManager),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, driverPackage.EntityManager),
                    ],
                    exports: [
                        core_1.MikroORM,
                        core_1.EntityManager,
                        driverPackage.EntityManager,
                        driverPackage.MikroORM,
                    ],
                };
            }
        }
        return {
            module: MikroOrmCoreModule_1,
            providers: [
                { provide: mikro_orm_common_1.MIKRO_ORM_MODULE_OPTIONS, useValue: options || {} },
                (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName),
                ...(mongo ? [(0, mikro_orm_providers_1.createMikroOrmProvider)(contextName, mongo.MikroORM)] : []),
                (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, core_1.EntityManager, contextName),
                ...(em ? [(0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, em.constructor, contextName)] : []),
                ...(knex ? [(0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, knex.EntityManager, contextName)] : []),
                ...(mongo ? [(0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, mongo.EntityManager, contextName)] : []),
            ],
            exports: [
                contextName ? (0, mikro_orm_common_1.getMikroORMToken)(contextName) : core_1.MikroORM,
                contextName ? (0, mikro_orm_common_1.getEntityManagerToken)(contextName) : core_1.EntityManager,
                ...(em && !contextName ? [em.constructor] : []),
                ...(knex && !contextName ? [knex.EntityManager] : []),
                ...(mongo && !contextName ? [mongo.EntityManager, mongo.MikroORM] : []),
            ],
        };
    }
    static async forRootAsync(options) {
        const contextName = this.setContextName(options?.contextName);
        if (options?.driver && !contextName) {
            const packageName = PACKAGES[options.driver.name];
            const driverPackage = await tryRequire(packageName);
            if (driverPackage) {
                return {
                    module: MikroOrmCoreModule_1,
                    imports: options.imports || [],
                    providers: [
                        ...(options.providers || []),
                        ...(0, mikro_orm_providers_1.createAsyncProviders)({ ...options, contextName: options.contextName }),
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName),
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName, driverPackage.MikroORM),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, core_1.EntityManager),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, driverPackage.EntityManager),
                    ],
                    exports: [
                        core_1.MikroORM,
                        core_1.EntityManager,
                        driverPackage.EntityManager,
                        driverPackage.MikroORM,
                    ],
                };
            }
        }
        const knex = await tryRequire('@mikro-orm/knex');
        const mongo = await tryRequire('@mikro-orm/mongodb');
        const em = await this.createEntityManager(options);
        if (em && !contextName) {
            const packageName = PACKAGES[em.getDriver().constructor.name];
            const driverPackage = await tryRequire(packageName);
            if (driverPackage) {
                return {
                    module: MikroOrmCoreModule_1,
                    imports: options.imports || [],
                    providers: [
                        ...(options.providers || []),
                        ...(0, mikro_orm_providers_1.createAsyncProviders)({ ...options, contextName: options.contextName }),
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName),
                        (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName, driverPackage.MikroORM),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, core_1.EntityManager),
                        (0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, driverPackage.EntityManager),
                    ],
                    exports: [
                        core_1.MikroORM,
                        core_1.EntityManager,
                        driverPackage.EntityManager,
                        driverPackage.MikroORM,
                    ],
                };
            }
        }
        return {
            module: MikroOrmCoreModule_1,
            imports: options.imports || [],
            providers: [
                ...(options.providers || []),
                ...(0, mikro_orm_providers_1.createAsyncProviders)({ ...options, contextName: options.contextName }),
                (0, mikro_orm_providers_1.createMikroOrmProvider)(contextName),
                ...(mongo ? [(0, mikro_orm_providers_1.createMikroOrmProvider)(contextName, mongo.MikroORM)] : []),
                (0, mikro_orm_providers_1.createEntityManagerProvider)(options.scope, core_1.EntityManager, contextName),
                ...(em ? [(0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, em.constructor, contextName)] : []),
                ...(knex ? [(0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, knex.EntityManager, contextName)] : []),
                ...(mongo ? [(0, mikro_orm_providers_1.createEntityManagerProvider)(options?.scope, mongo.EntityManager, contextName)] : []),
            ],
            exports: [
                contextName ? (0, mikro_orm_common_1.getMikroORMToken)(contextName) : core_1.MikroORM,
                contextName ? (0, mikro_orm_common_1.getEntityManagerToken)(contextName) : core_1.EntityManager,
                ...(em && !contextName ? [em.constructor] : []),
                ...(knex && !contextName ? [knex.EntityManager] : []),
                ...(mongo && !contextName ? [mongo.EntityManager, mongo.MikroORM] : []),
            ],
        };
    }
    /**
     * Tries to create the driver instance to use the actual entity manager implementation for DI symbol.
     * This helps with dependency resolution issues when importing the EM from driver package (e.g. `SqlEntityManager`).
     */
    static async createEntityManager(options) {
        if (options?.contextName) {
            return undefined;
        }
        try {
            let config;
            if (!options || Object.keys(options).length === 0) {
                config = await core_1.ConfigurationLoader.getConfiguration(false);
            }
            if (!config && 'useFactory' in options) {
                config = new core_1.Configuration(await options.useFactory(), false);
            }
            if (!config && options instanceof core_1.Configuration) {
                config = options;
            }
            if (!config && typeof options === 'object' && options && 'driver' in options) {
                config = new core_1.Configuration(options, false);
            }
            return config?.getDriver().createEntityManager();
        }
        catch {
            if (options && 'useFactory' in options && 'inject' in options && !options.driver && options.inject.length > 0) {
                // eslint-disable-next-line no-console
                console.warn('Support for driver specific imports in modules defined with `useFactory` and `inject` requires an explicit `driver` option. See https://github.com/mikro-orm/nestjs/pull/204');
            }
        }
    }
    async onApplicationShutdown() {
        const token = this.options.contextName ? (0, mikro_orm_common_1.getMikroORMToken)(this.options.contextName) : core_1.MikroORM;
        const orm = this.moduleRef.get(token);
        if (orm) {
            await orm.close();
            mikro_orm_entities_storage_1.MikroOrmEntitiesStorage.clearLater();
        }
        mikro_orm_common_1.CONTEXT_NAMES.length = 0;
    }
    configure(consumer) {
        if (this.options.registerRequestContext === false) {
            return;
        }
        consumer
            .apply(mikro_orm_middleware_1.MikroOrmMiddleware) // register request context automatically
            .forRoutes({ path: (0, middleware_helper_1.forRoutesPath)(this.options, consumer), method: common_1.RequestMethod.ALL });
    }
    static setContextName(contextName) {
        if (!contextName) {
            return;
        }
        if (mikro_orm_common_1.CONTEXT_NAMES.includes(contextName)) {
            throw new Error(`ContextName '${contextName}' already registered`);
        }
        mikro_orm_common_1.CONTEXT_NAMES.push(contextName);
        return contextName;
    }
};
exports.MikroOrmCoreModule = MikroOrmCoreModule;
exports.MikroOrmCoreModule = MikroOrmCoreModule = MikroOrmCoreModule_1 = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({}),
    __param(0, (0, common_1.Inject)(mikro_orm_common_1.MIKRO_ORM_MODULE_OPTIONS)),
    __metadata("design:paramtypes", [Object, core_2.ModuleRef])
], MikroOrmCoreModule);
