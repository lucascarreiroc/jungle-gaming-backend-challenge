"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMikroOrmProvider = createMikroOrmProvider;
exports.createEntityManagerProvider = createEntityManagerProvider;
exports.createMikroOrmAsyncOptionsProvider = createMikroOrmAsyncOptionsProvider;
exports.createAsyncProviders = createAsyncProviders;
exports.createMikroOrmRepositoryProviders = createMikroOrmRepositoryProviders;
const core_1 = require("@mikro-orm/core");
const mikro_orm_common_1 = require("./mikro-orm.common");
const common_1 = require("@nestjs/common");
const mikro_orm_entities_storage_1 = require("./mikro-orm.entities.storage");
function createMikroOrmProvider(contextName, type = core_1.MikroORM) {
    if (!contextName && type !== core_1.MikroORM) {
        return {
            provide: type,
            useFactory: orm => orm, // just a simple alias
            inject: [core_1.MikroORM], // depend on the ORM from core package
        };
    }
    return {
        provide: contextName ? (0, mikro_orm_common_1.getMikroORMToken)(contextName) : type,
        useFactory: async (options) => {
            options = { ...options };
            if (options?.autoLoadEntities) {
                options.entities = [...(options.entities || []), ...mikro_orm_entities_storage_1.MikroOrmEntitiesStorage.getEntities(contextName)];
                options.entitiesTs = [...(options.entitiesTs || []), ...mikro_orm_entities_storage_1.MikroOrmEntitiesStorage.getEntities(contextName)];
                delete options.autoLoadEntities;
            }
            if (!options || Object.keys(options).length === 0) {
                const config = await core_1.ConfigurationLoader.getConfiguration();
                config.set('logger', mikro_orm_common_1.logger.log.bind(mikro_orm_common_1.logger));
                options = config.getAll();
            }
            return core_1.MikroORM.init(options);
        },
        inject: [mikro_orm_common_1.MIKRO_ORM_MODULE_OPTIONS],
    };
}
function createEntityManagerProvider(scope = common_1.Scope.DEFAULT, entityManager = core_1.EntityManager, contextName, forkOptions) {
    if (!contextName && entityManager !== core_1.EntityManager) {
        return {
            provide: entityManager,
            scope,
            useFactory: (em) => em, // just a simple alias, unlike `useExisting` from nest, this works with request scopes too
            inject: [core_1.EntityManager], // depend on the EM from core package
        };
    }
    return {
        provide: contextName ? (0, mikro_orm_common_1.getEntityManagerToken)(contextName) : entityManager,
        scope,
        useFactory: (orm) => scope === common_1.Scope.DEFAULT ? orm.em : orm.em.fork({ useContext: true, ...forkOptions }),
        inject: [contextName ? (0, mikro_orm_common_1.getMikroORMToken)(contextName) : core_1.MikroORM],
    };
}
function createMikroOrmAsyncOptionsProvider(options) {
    if (options.useFactory) {
        return {
            provide: mikro_orm_common_1.MIKRO_ORM_MODULE_OPTIONS,
            useFactory: async (...args) => {
                const factoryOptions = await options.useFactory(...args);
                return options.contextName
                    ? { contextName: options.contextName, ...factoryOptions }
                    : factoryOptions;
            },
            inject: options.inject || [],
        };
    }
    const inject = [];
    if (options.useClass || options.useExisting) {
        inject.push(options.useClass ?? options.useExisting);
    }
    return {
        provide: mikro_orm_common_1.MIKRO_ORM_MODULE_OPTIONS,
        useFactory: async (optionsFactory) => await optionsFactory.createMikroOrmOptions(options.contextName),
        inject,
    };
}
function createAsyncProviders(options) {
    if (options.useExisting || options.useFactory) {
        return [createMikroOrmAsyncOptionsProvider(options)];
    }
    if (options.useClass) {
        return [
            createMikroOrmAsyncOptionsProvider(options),
            { provide: options.useClass, useClass: options.useClass },
        ];
    }
    throw new Error('Invalid MikroORM async options: one of `useClass`, `useExisting` or `useFactory` should be defined.');
}
function createMikroOrmRepositoryProviders(entities, contextName) {
    const metadata = Object.values(core_1.MetadataStorage.getMetadata());
    const providers = [];
    const inject = contextName ? (0, mikro_orm_common_1.getEntityManagerToken)(contextName) : core_1.EntityManager;
    (entities || []).forEach(entity => {
        const meta = metadata.find(meta => meta.class === entity);
        const repository = meta?.repository;
        if (repository) {
            providers.push({
                provide: repository(),
                useFactory: em => em.getRepository(entity),
                inject: [inject],
            });
        }
        providers.push({
            provide: (0, mikro_orm_common_1.getRepositoryToken)(entity, contextName),
            useFactory: em => em.getRepository(entity),
            inject: [inject],
        });
    });
    return providers;
}
