// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {CHANNELS_CATEGORY} from '@constants/categories';
import {MM_TABLES, SYSTEM_IDENTIFIERS} from '@constants/database';
import DatabaseManager from '@database/manager';
import NetworkManager from '@managers/network_manager';
import {getChannelById, getMyChannel, queryMyChannelsByTeam} from '@queries/servers/channel';
import EphemeralStore from '@store/ephemeral_store';
import TestHelper from '@test/test_helper';

import {handleChannelUnarchiveEvent} from './channel';

jest.mock('@database/manager');

const serverUrl = 'channel-unarchive.test.com';
const teamId = 'unarchive-team';
const userId = 'unarchive-user';
const channelId = 'unarchive-channel';
const categoryId = 'unarchive-category';
const {CHANNEL, MY_CHANNEL, CATEGORY_CHANNEL} = MM_TABLES.SERVER;

describe('channel unarchive persistence (GH-26673)', () => {
    const getChannel = jest.fn();
    const getChannelMember = jest.fn();
    const msg = {data: {channel_id: channelId}};
    let channel: Channel;
    let member: ChannelMembership;

    beforeEach(async () => {
        await DatabaseManager.init([serverUrl]);
        const {operator} = DatabaseManager.getServerDatabaseAndOperator(serverUrl);
        await operator.handleSystem({systems: [{id: SYSTEM_IDENTIFIERS.CURRENT_USER_ID, value: userId}], prepareRecordsOnly: false});
        await operator.handleCategories({
            categories: [{...TestHelper.fakeCategory(teamId), id: categoryId, type: CHANNELS_CATEGORY}],
            prepareRecordsOnly: false,
        });
        channel = {...TestHelper.fakeChannelWithId(teamId), id: channelId, delete_at: 0};
        member = TestHelper.fakeChannelMember({channel_id: channelId, user_id: userId});
        getChannel.mockReset().mockResolvedValue(channel);
        getChannelMember.mockReset().mockResolvedValue(member);
        jest.spyOn(NetworkManager, 'getClient').mockReturnValue({getChannel, getChannelMember} as unknown as ReturnType<typeof NetworkManager.getClient>);
        EphemeralStore.removeArchivingChannel(channelId);
    });

    afterEach(async () => {
        EphemeralStore.removeArchivingChannel(channelId);
        jest.restoreAllMocks();
        await DatabaseManager.destroyServerDatabase(serverUrl);
    });

    it('should restore an archived channel already stored locally without fetching it', async () => {
        const {database, operator} = DatabaseManager.getServerDatabaseAndOperator(serverUrl);
        await operator.handleChannel({channels: [{...channel, delete_at: 123}], prepareRecordsOnly: false});

        await handleChannelUnarchiveEvent(serverUrl, msg);

        expect((await getChannelById(database, channelId))?.deleteAt).toBe(0);
        expect(await database.get(CHANNEL).query().fetchCount()).toBe(1);
        expect(getChannel).not.toHaveBeenCalled();
    });

    it('should recover a missing channel with membership and sidebar category without restarting', async () => {
        const {database} = DatabaseManager.getServerDatabaseAndOperator(serverUrl);
        expect(await getChannelById(database, channelId)).toBeUndefined();

        await handleChannelUnarchiveEvent(serverUrl, msg);

        expect(getChannel).toHaveBeenCalledWith(channelId, undefined);
        expect(getChannelMember).toHaveBeenCalledWith(channelId, 'me', undefined);
        expect((await getChannelById(database, channelId))?.deleteAt).toBe(0);
        expect(await getMyChannel(database, channelId)).toBeDefined();
        expect(await queryMyChannelsByTeam(database, teamId).fetchIds()).toEqual([channelId]);
        const mappings = await database.get(CATEGORY_CHANNEL).query().fetch();
        expect(mappings).toHaveLength(1);
        expect(mappings[0]).toEqual(expect.objectContaining({categoryId, channelId}));
    });

    it('should keep one channel membership and category entry when the event is delivered twice', async () => {
        const {database} = DatabaseManager.getServerDatabaseAndOperator(serverUrl);

        await handleChannelUnarchiveEvent(serverUrl, msg);
        await handleChannelUnarchiveEvent(serverUrl, msg);

        expect(await database.get(CHANNEL).query().fetchCount()).toBe(1);
        expect(await database.get(MY_CHANNEL).query().fetchCount()).toBe(1);
        expect(await database.get(CATEGORY_CHANNEL).query().fetchCount()).toBe(1);
        expect(getChannel).toHaveBeenCalledTimes(1);
    });

    it('should share recovery when duplicate events arrive concurrently', async () => {
        const {database} = DatabaseManager.getServerDatabaseAndOperator(serverUrl);

        await Promise.all([
            handleChannelUnarchiveEvent(serverUrl, msg),
            handleChannelUnarchiveEvent(serverUrl, msg),
        ]);

        expect(await database.get(CHANNEL).query().fetchCount()).toBe(1);
        expect(await database.get(MY_CHANNEL).query().fetchCount()).toBe(1);
        expect(await database.get(CATEGORY_CHANNEL).query().fetchCount()).toBe(1);
        expect(getChannel).toHaveBeenCalledTimes(1);
        expect(getChannelMember).toHaveBeenCalledTimes(1);
    });

    it('should leave no partial records when the membership cannot be fetched and allow a later retry', async () => {
        const {database} = DatabaseManager.getServerDatabaseAndOperator(serverUrl);
        getChannelMember.mockRejectedValueOnce(new Error('membership unavailable'));

        await handleChannelUnarchiveEvent(serverUrl, msg);

        expect(await database.get(CHANNEL).query().fetchCount()).toBe(0);
        expect(await database.get(MY_CHANNEL).query().fetchCount()).toBe(0);
        expect(await database.get(CATEGORY_CHANNEL).query().fetchCount()).toBe(0);

        await handleChannelUnarchiveEvent(serverUrl, msg);

        expect(await getMyChannel(database, channelId)).toBeDefined();
        expect(getChannelMember).toHaveBeenCalledTimes(2);
    });

    it('should ignore the event while the channel is being archived locally', async () => {
        const {database} = DatabaseManager.getServerDatabaseAndOperator(serverUrl);
        EphemeralStore.addArchivingChannel(channelId);

        await handleChannelUnarchiveEvent(serverUrl, msg);

        expect(await getChannelById(database, channelId)).toBeUndefined();
        expect(getChannel).not.toHaveBeenCalled();
    });

    it('should not fetch a channel after its server database has been removed', async () => {
        await DatabaseManager.destroyServerDatabase(serverUrl);

        await expect(handleChannelUnarchiveEvent(serverUrl, msg)).resolves.toBeUndefined();

        expect(getChannel).not.toHaveBeenCalled();
    });
});
