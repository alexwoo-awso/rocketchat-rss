import {
    IAppAccessors,
    IConfigurationExtend,
    IEnvironmentRead,
    IConfigurationModify,
    IHttp,
    ILogger,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import { ISetting } from '@rocket.chat/apps-engine/definition/settings';

import { RssCommand } from './commands/RssCommand';
import { settings } from './config/Settings';

export class RssFeedApp extends App {
    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
    }

    public async extendConfiguration(configuration: IConfigurationExtend, _environmentRead: IEnvironmentRead): Promise<void> {
        await Promise.all(
            settings.map((setting) => configuration.settings.provideSetting(setting)),
        );

        configuration.slashCommands.provideSlashCommand(new RssCommand(this));
    }

    public async onSettingUpdated(
        setting: ISetting,
        _configurationModify: IConfigurationModify,
        _read: IRead,
        _http: IHttp,
    ): Promise<void> {
        this.getLogger().debug(`Setting updated: ${setting.id}`);
    }
}
