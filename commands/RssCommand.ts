import {
    IHttp,
    IModify,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import {
    ISlashCommand,
    SlashCommandContext,
} from '@rocket.chat/apps-engine/definition/slashcommands';

import { RssFeedApp } from '../RssFeedApp';
import { RssFeedService } from '../lib/RssFeedService';

export class RssCommand implements ISlashCommand {
    public command = 'rss';
    public i18nParamsExample = 'help | subscribe <feed-url> [#channel]';
    public i18nDescription = 'Manage RSS feed subscriptions';
    public providesPreview = false;

    constructor(private readonly app: RssFeedApp) {}

    public async executor(context: SlashCommandContext, _read: IRead, modify: IModify, http: IHttp): Promise<void> {
        const args = context.getArguments();

        if (!args.length || args[0] === 'help') {
            await this.sendMessage(
                context,
                modify,
                [
                    'RSS commands:',
                    '/rss help',
                    '/rss subscribe <feed-url> [#channel]',
                ].join('\n'),
            );
            return;
        }

        const service = new RssFeedService(this.app);
        const response = await service.handleCommand(args, http);

        await this.sendMessage(context, modify, response);
    }

    private async sendMessage(context: SlashCommandContext, modify: IModify, text: string): Promise<void> {
        const messageBuilder = modify.getCreator().startMessage();
        messageBuilder
            .setSender(context.getSender())
            .setRoom(context.getRoom())
            .setText(text);

        await modify.getCreator().finish(messageBuilder);
    }
}
