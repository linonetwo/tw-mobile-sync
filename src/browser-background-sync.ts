/* eslint-disable unicorn/no-array-callback-reference */
import type { Tiddler, IServerStatus, ITiddlerFieldsParam } from 'tiddlywiki';
import mapValues from 'lodash/mapValues';
import { activeServerStateTiddlerTitle, clientStatusStateTiddlerTitle, getLoopInterval } from './data/constants';
import { getDiffFilter, serverListFilter } from './data/filters';
import { getClientInfoPoint, getFullHtmlEndPoint, getStatusEndPoint, getSyncEndPoint } from './data/getEndPoint';
import type { ISyncEndPointRequest, IClientInfo } from './types';
import { ConnectionState } from './types';
import cloneDeep from 'lodash/cloneDeep';
import take from 'lodash/take';

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
exports.name = 'browser-background-sync';
exports.platforms = ['browser'];
// modules listed in https://tiddlywiki.com/dev/#StartupMechanism
// not blocking rendering
exports.after = ['render'];
exports.synchronous = true;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

interface IServerInfoTiddler extends Tiddler {
  fields: Tiddler['fields'] & {
    ipAddress: string;
    /**
     * Last synced time, be undefined if never synced
     */
    lastSync: string | undefined;
    name: string;
    port: number;
    text: ConnectionState;
  };
}

class BackgroundSyncManager {
  loop: ReturnType<typeof setInterval> | undefined;
  loopInterval: number;
  /** lock the sync for `this.syncWithServer`, while last sync is still on progress */
  lock = false;

  constructor() {
    // TODO: get this from setting
    this.loopInterval = getLoopInterval();
    this.setupListener();
  }

  setupListener() {
    $tw.rootWidget.addEventListener('tw-mobile-sync-get-server-status', async (event) => await this.getServerStatus());
    $tw.rootWidget.addEventListener('tw-mobile-sync-set-active-server-and-sync', async (event) => {
      const titleToActive = event.paramObject?.title as string | undefined;
      await this.setActiveServerAndSync(titleToActive);
    });
    /** handle events from src/ui/ServerItemViewTemplate.tid 's $:/plugins/linonetwo/tw-mobile-sync/ui/ServerItemViewTemplate */
    $tw.rootWidget.addEventListener('tw-mobile-sync-sync-start', async (event) => await this.start());
    $tw.rootWidget.addEventListener('tw-mobile-sync-download-full-html', async (event) => await this.downloadFullHtmlAndApplyToWiki());
  }

  async start(skipStatusCheck?: boolean) {
    if (this.loop !== undefined) {
      clearInterval(this.loop);
      this.lock = false;
    }
    const loopHandler = async () => {
      void this.getConnectedClientStatus();
      if (this.lock) {
        return;
      }
      this.lock = true;
      try {
        if (skipStatusCheck !== true) {
          await this.getServerStatus();
        }
        await this.syncWithServer();
      } finally {
        this.lock = false;
      }
    };
    await loopHandler();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.loop = setInterval(loopHandler, this.loopInterval);
  }

  async setActiveServerAndSync(titleToActive: string | undefined) {
    try {
      if (typeof titleToActive === 'string' && $tw.wiki.getTiddler(titleToActive) !== undefined) {
        // update status first
        await this.getServerStatus();
        // get latest tiddler
        const serverToActive = $tw.wiki.getTiddler<IServerInfoTiddler>(titleToActive);
        if (serverToActive !== undefined) {
          const newStatus = [ConnectionState.onlineActive, ConnectionState.online].includes(serverToActive.fields.text as ConnectionState)
            ? ConnectionState.onlineActive
            : ConnectionState.offlineActive;
          $tw.wiki.addTiddler({ ...serverToActive.fields, text: newStatus });
          this.setActiveServerTiddlerTitle(titleToActive, serverToActive.fields.lastSync);
          await this.start(true);
        }
      }
    } catch (error) {
      console.error(error);
    }
  }

  getActiveServerTiddlerTitle() {
    return $tw.wiki.getTiddlerText(activeServerStateTiddlerTitle);
  }

  setActiveServerTiddlerTitle(title: string, lastSync: string | undefined) {
    // update active server record in `activeServerStateTiddlerTitle`, this is a pointer tiddler point to actual server tiddler
    $tw.wiki.addTiddler({ title: activeServerStateTiddlerTitle, text: title, lastSync });
    // update server's last sync
    const serverToActive = $tw.wiki.getTiddler(title);
    if (serverToActive !== undefined) {
      $tw.wiki.addTiddler({ ...serverToActive.fields, lastSync });
    }
  }

  /** On TidGi desktop, get connected client info */
  async getConnectedClientStatus() {
    const response: Record<string, IClientInfo> = await fetch(getClientInfoPoint()).then(
      async (response) => (await response.json()) as Record<string, IClientInfo>,
    );
    Object.values(response).forEach((clientInfo) => {
      $tw.wiki.addTiddler({
        title: `${clientStatusStateTiddlerTitle}/${clientInfo.Origin}`,
        ...clientInfo,
      });
    });
  }

  /** On Tiddloid mobile, get TidGi server status */
  async getServerStatus() {
    const timeout = 3000;
    const activeTiddlerTitle = this.getActiveServerTiddlerTitle();
    const serverListWithUpdatedStatus = await Promise.all(
      this.serverList.map(async (serverInfoTiddler) => {
        const active = serverInfoTiddler.fields.title === activeTiddlerTitle;
        try {
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), timeout);
          const response: IServerStatus = await fetch(getStatusEndPoint(serverInfoTiddler.fields.ipAddress, serverInfoTiddler.fields.port), {
            signal: controller.signal,
          }).then(async (response) => (await response.json()) as IServerStatus);
          clearTimeout(id);
          if (typeof response.tiddlywiki_version === 'string') {
            return {
              ...serverInfoTiddler,
              fields: {
                ...serverInfoTiddler.fields,
                text: active ? ConnectionState.onlineActive : ConnectionState.online,
              },
            };
          }
        } catch (error) {
          if ((error as Error).message.includes('The operation was aborted')) {
            $tw.wiki.addTiddler({
              title: '$:/state/notification/tw-mobile-sync/notification',
              text: `GetServerStatus Timeout after ${timeout / 1000}s`,
            });
          } else {
            console.error(`getServerStatus() ${(error as Error).message} ${serverInfoTiddler.fields.name} ${(error as Error).stack ?? ''}`);
            $tw.wiki.addTiddler({
              title: '$:/state/notification/tw-mobile-sync/notification',
              text: `GetServerStatus Failed ${(error as Error).message}`,
            });
          }
        }
        $tw.notifier.display('$:/state/notification/tw-mobile-sync/notification');
        return {
          ...serverInfoTiddler,
          fields: {
            ...serverInfoTiddler.fields,
            text: active ? ConnectionState.offlineActive : ConnectionState.offline,
          },
        };
      }),
    );
    serverListWithUpdatedStatus.forEach((tiddler) => {
      $tw.wiki.addTiddler(tiddler.fields);
    });
  }

  async syncWithServer() {
    const onlineActiveServer = this.onlineActiveServer;

    if (onlineActiveServer !== undefined) {
      const tiddlersToNotSync = new Set(
        ($tw.wiki.getTiddlerText('$:/plugins/linonetwo/tw-mobile-sync/Config/TiddlersToNotSync') ?? '')
          .split(' ')
          .map((tiddlerName) => tiddlerName.replace('[[', '').replace(']]', '')),
      );
      const prefixToNotSync = ($tw.wiki.getTiddlerText('$:/plugins/linonetwo/tw-mobile-sync/Config/TiddlersPrefixToNotSync') ?? '')
        .split(' ')
        .map((tiddlerName) => tiddlerName.replace('[[', '').replace(']]', ''));
      try {
        const changedTiddlersFromClient = this.currentModifiedTiddlers
          .filter((tiddler: ITiddlerFieldsParam) => !prefixToNotSync.some((prefix) => (tiddler.title as string).startsWith(prefix)))
          .filter((tiddler: ITiddlerFieldsParam) => !tiddlersToNotSync.has(tiddler.title as string));
        const requestBody: ISyncEndPointRequest = { tiddlers: changedTiddlersFromClient, lastSync: onlineActiveServer.fields.lastSync };
        // TODO: handle conflict, find intersection of changedTiddlersFromServer and changedTiddlersFromClient, and write changes to each other
        // send modified tiddlers to server
        const changedTiddlersFromServer: ITiddlerFieldsParam[] = await fetch(
          getSyncEndPoint(onlineActiveServer.fields.ipAddress, onlineActiveServer.fields.port),
          {
            method: 'POST',
            mode: 'cors',
            body: JSON.stringify(requestBody),
            headers: {
              'X-Requested-With': 'TiddlyWiki',
              'Content-Type': 'application/json',
            },
            // TODO: add auth token in header, after we can scan QR code to get token easily
          },
        ).then(async (response) => ((await response.json()) as ITiddlerFieldsParam[]).filter((tiddler) => !tiddlersToNotSync.has(tiddler.title as string)));
        changedTiddlersFromServer.forEach((tiddler) => {
          // TODO: handle conflict
          $tw.wiki.addTiddler(tiddler);
        });
        const changedTitleDisplayLimit = 5;
        const clientText = take(changedTiddlersFromClient, changedTitleDisplayLimit)
          .map((tiddler) => tiddler.caption ?? (tiddler.title as string))
          .join(' ');
        const clientCount =
          changedTiddlersFromClient.length > changedTitleDisplayLimit ? `And ${changedTiddlersFromClient.length - changedTitleDisplayLimit} more` : '';
        const serverText = take(changedTiddlersFromServer, changedTitleDisplayLimit)
          .map((tiddler) => tiddler.caption ?? (tiddler.title as string))
          .join(' ');
        const serverCount =
          changedTiddlersFromServer.length > changedTitleDisplayLimit ? `And ${changedTiddlersFromServer.length - changedTitleDisplayLimit} more` : '';
        $tw.wiki.addTiddler({
          title: '$:/state/notification/tw-mobile-sync/notification',
          text: `Sync Complete ↑ ${changedTiddlersFromClient.length} ↓ ${changedTiddlersFromServer.length}${
            changedTiddlersFromClient.length > 0 ? `\n\n↑: ${clientText} ${clientCount}` : ''
          }${changedTiddlersFromServer.length > 0 ? `\n\n↓: ${serverText} ${serverCount}` : ''}`,
        });
        this.setActiveServerTiddlerTitle(onlineActiveServer.fields.title, this.getLastSyncString());
      } catch (error) {
        console.error(error);
        $tw.wiki.addTiddler({
          title: '$:/state/notification/tw-mobile-sync/notification',
          text: `Sync Failed ${(error as Error).message}`,
        });
      }
      $tw.notifier.display('$:/state/notification/tw-mobile-sync/notification');
    }
  }

  async downloadFullHtmlAndApplyToWiki() {
    const onlineActiveServer = this.onlineActiveServer;

    if (onlineActiveServer !== undefined) {
      try {
        const fullHtml = await fetch(getFullHtmlEndPoint(onlineActiveServer.fields.ipAddress, onlineActiveServer.fields.port), {
          mode: 'cors',
          headers: {
            'X-Requested-With': 'TiddlyWiki',
            'Content-Type': 'application/json',
          },
        }).then(async (response) => await response.text());
        this.setActiveServerTiddlerTitle(onlineActiveServer.fields.title, this.getLastSyncString());
        // get all state tiddlers we need, before document is overwritten
        const serverList = cloneDeep(this.serverList);

        // overwrite
        document.write(fullHtml);
        document.close();

        // write back
        $tw.wiki.addTiddlers(serverList.map((tiddler) => tiddler.fields));
      } catch (error) {
        console.error(error);
      }
    }
  }

  get onlineActiveServer() {
    return this.serverList.find((serverInfoTiddler) => {
      // TODO: compile to lower es for browser support
      return serverInfoTiddler?.fields?.text === ConnectionState.onlineActive;
    });
  }

  /**
   *  update last sync using <<now "[UTC]YYYY0MM0DD0hh0mm0ssXXX">>
   */
  getLastSyncString() {
    return $tw.utils.stringifyDate(new Date());
  }

  get currentModifiedTiddlers(): ITiddlerFieldsParam[] {
    const onlineActiveServer = this.onlineActiveServer;

    if (onlineActiveServer === undefined) {
      return [];
    }
    const lastSync = onlineActiveServer.fields.lastSync;
    const diffTiddlersFilter: string = getDiffFilter(lastSync);
    const diffTiddlers: string[] = $tw.wiki.compileFilter(diffTiddlersFilter)() ?? [];
    return diffTiddlers
      .map($tw.wiki.getTiddler)
      .filter((tiddler): tiddler is Tiddler => tiddler !== undefined)
      .map(
        (tiddler): ITiddlerFieldsParam =>
          mapValues(tiddler.fields, (value) => {
            if (value instanceof Date) {
              return $tw.utils.stringifyDate(value);
            }
            return value as string;
          }),
      );
  }

  get serverList() {
    // get server list using filter
    const serverList: string[] = $tw.wiki.compileFilter(serverListFilter)() ?? [];
    return serverList.map((serverInfoTiddlerTitle) => {
      return $tw.wiki.getTiddler(serverInfoTiddlerTitle) as IServerInfoTiddler;
    });
  }
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
exports.startup = () => {
  const syncManager = new BackgroundSyncManager();
  void syncManager.start();
};
