"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InjectRepository = exports.getRepositoryToken = exports.InjectEntityManager = exports.getEntityManagerToken = exports.InjectMikroORMs = exports.InjectMikroORM = exports.getMikroORMToken = exports.logger = exports.CONTEXT_NAMES = exports.MIKRO_ORM_MODULE_OPTIONS = void 0;
const core_1 = require("@mikro-orm/core");
const common_1 = require("@nestjs/common");
exports.MIKRO_ORM_MODULE_OPTIONS = Symbol('mikro-orm-module-options');
exports.CONTEXT_NAMES = [];
exports.logger = new common_1.Logger(core_1.MikroORM.name);
/**
 * Gets the injection token based on context name for the relevant MikroORM provider.
 * @param name The context name of the database connection.
 * @returns The MikroORM provider injection token for the supplied context name.
 */
const getMikroORMToken = (name) => `${name}_MikroORM`;
exports.getMikroORMToken = getMikroORMToken;
/**
 * Injects a MikroORM provider based on the supplied context name.
 *
 * @param name The context name of the database connection.
 * @returns A parameter decorator which will cause NestJS to inject the relevant MikroORM provider.
 */
const InjectMikroORM = (name) => (0, common_1.Inject)((0, exports.getMikroORMToken)(name));
exports.InjectMikroORM = InjectMikroORM;
/**
 * Injects the MikroORMs provider.
 *
 * @returns A decorator which will cause NestJS to inject the MikroORMs provider.
 */
const InjectMikroORMs = () => (0, common_1.Inject)('MikroORMs');
exports.InjectMikroORMs = InjectMikroORMs;
/**
 * Gets the injection token based on context name for the relevant EntityManager provider.
 * @param name The context name of the database connection.
 * @returns The EntityManager provider injection token for the supplied context name.
 */
const getEntityManagerToken = (name) => `${name}_EntityManager`;
exports.getEntityManagerToken = getEntityManagerToken;
/**
 * Injects an EntityManager provider based on the supplied context name.
 *
 * @param name The context name of the database connection.
 * @returns A parameter decorator which will cause NestJS to inject the relevant EntityManager provider.
 */
const InjectEntityManager = (name) => (0, common_1.Inject)((0, exports.getEntityManagerToken)(name));
exports.InjectEntityManager = InjectEntityManager;
/**
 * Gets the injection token based on class and optionally based on context name.
 * @param entity The class of the Entity to use for the injected repository provider.
 * @param name An optional context name - required for multiple database connections. See: [Multiple Database Connections](https://mikro-orm.io/docs/usage-with-nestjs#multiple-database-connections)
 * @returns The EntityRepository provider injection token based on the supplied entity and context name.
 */
const getRepositoryToken = (entity, name) => {
    const suffix = name ? `_${name}` : '';
    return `${core_1.Utils.className(entity)}Repository${suffix}`;
};
exports.getRepositoryToken = getRepositoryToken;
/**
 * Injects an EntityRepository provider.
 *
 * @param entity The class of the Entity to use for the injected repository provider.
 * @param name An optional context name - required for multiple database connections. See: [Multiple Database Connections](https://mikro-orm.io/docs/usage-with-nestjs#multiple-database-connections)
 * @returns A parameter decorator which will cause NestJS to inject the relevant EntityRepository provider.
 */
const InjectRepository = (entity, name) => (0, common_1.Inject)((0, exports.getRepositoryToken)(entity, name));
exports.InjectRepository = InjectRepository;
