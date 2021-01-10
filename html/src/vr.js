// Copyright(c) 2019-2020 pypy and individual contributors.
// All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

import Noty from 'noty';
import Vue from 'vue';
import ElementUI from 'element-ui';
import locale from 'element-ui/lib/locale/lang/en';

import sharedRepository from './repository/shared.js';
import configRepository from './repository/config.js';
import webApiService from './service/webapi.js';
import ProgressBar from 'progressbar.js';

speechSynthesis.getVoices();

var bar = new ProgressBar.Circle(vroverlay, {
  strokeWidth: 50,
  easing: 'easeInOut',
  duration: 500,
  color: '#aaa',
  trailWidth: 0,
  svgStyle: null
});

(async function () {
    await CefSharp.BindObjectAsync(
        'AppApi',
        'WebApi',
        'SharedVariable',
        'SQLite',
        'Discord'
    );

    await configRepository.init();

    Noty.overrideDefaults({
        animation: {
            open: 'animate__animated animate__fadeIn',
            close: 'animate__animated animate__zoomOut'
        },
        layout: 'topCenter',
        theme: 'relax',
        timeout: 3000
    });

    Vue.use(ElementUI, {
        locale
    });

    var escapeTag = (s) => String(s).replace(/["&'<>]/gu, (c) => `&#${c.charCodeAt(0)};`);
    Vue.filter('escapeTag', escapeTag);

    var commaNumber = (n) => String(Number(n) || 0).replace(/(\d)(?=(\d{3})+(?!\d))/gu, '$1,');
    Vue.filter('commaNumber', commaNumber);

    var formatDate = (s, format) => {
        var dt = new Date(s);
        if (isNaN(dt)) {
            return escapeTag(s);
        }
        var hours = dt.getHours();
        var map = {
            'YYYY': String(10000 + dt.getFullYear()).substr(-4),
            'MM': String(101 + dt.getMonth()).substr(-2),
            'DD': String(100 + dt.getDate()).substr(-2),
            'HH24': String(100 + hours).substr(-2),
            'HH': String(100 + (hours > 12
                ? hours - 12
                : hours)).substr(-2),
            'MI': String(100 + dt.getMinutes()).substr(-2),
            'SS': String(100 + dt.getSeconds()).substr(-2),
            'AMPM': hours >= 12
                ? 'PM'
                : 'AM'
        };
        return format.replace(/YYYY|MM|DD|HH24|HH|MI|SS|AMPM/gu, (c) => map[c] || c);
    };
    Vue.filter('formatDate', formatDate);

    var textToHex = (s) => String(s).split('').map((c) => c.charCodeAt(0).toString(16)).join(' ');
    Vue.filter('textToHex', textToHex);

    var timeToText = (t) => {
        var sec = Number(t);
        if (isNaN(sec)) {
            return escapeTag(t);
        }
        sec = Math.floor(sec / 1000);
        var arr = [];
        if (sec < 0) {
            sec = -sec;
        }
        if (sec >= 86400) {
            arr.push(`${Math.floor(sec / 86400)}d`);
            sec %= 86400;
        }
        if (sec >= 3600) {
            arr.push(`${Math.floor(sec / 3600)}h`);
            sec %= 3600;
        }
        if (sec >= 60) {
            arr.push(`${Math.floor(sec / 60)}m`);
            sec %= 60;
        }
        if (sec ||
            !arr.length) {
            arr.push(`${sec}s`);
        }
        return arr.join(' ');
    };
    Vue.filter('timeToText', timeToText);

    //
    // API
    //

    var API = {};

    API.eventHandlers = new Map();

    API.$emit = function (name, ...args) {
        // console.log(name, ...args);
        var handlers = this.eventHandlers.get(name);
        if (handlers === undefined) {
            return;
        }
        try {
            for (var handler of handlers) {
                handler.apply(this, args);
            }
        } catch (err) {
            console.error(err);
        }
    };

    API.$on = function (name, handler) {
        var handlers = this.eventHandlers.get(name);
        if (handlers === undefined) {
            handlers = [];
            this.eventHandlers.set(name, handlers);
        }
        handlers.push(handler);
    };

    API.$off = function (name, handler) {
        var handlers = this.eventHandlers.get(name);
        if (handlers === undefined) {
            return;
        }
        var { length } = handlers;
        for (var i = 0; i < length; ++i) {
            if (handlers[i] === handler) {
                if (length > 1) {
                    handlers.splice(i, 1);
                } else {
                    this.eventHandlers.delete(name);
                }
                break;
            }
        }
    };

    API.pendingGetRequests = new Map();

    API.call = function (endpoint, options) {
        var init = {
            url: `https://api.vrchat.cloud/api/1/${endpoint}`,
            method: 'GET',
            ...options
        };
        var { params } = init;
        var isGetRequest = init.method === 'GET';
        if (isGetRequest === true) {
            // transform body to url
            if (params === Object(params)) {
                var url = new URL(init.url);
                var { searchParams } = url;
                for (var key in params) {
                    searchParams.set(key, params[key]);
                }
                init.url = url.toString();
            }
            // merge requests
            var req = this.pendingGetRequests.get(init.url);
            if (req !== undefined) {
                return req;
            }
        } else {
            init.headers = {
                'Content-Type': 'application/json;charset=utf-8',
                ...init.headers
            };
            init.body = params === Object(params)
                ? JSON.stringify(params)
                : '{}';
        }
        var req = webApiService.execute(init).catch((err) => {
            this.$throw(0, err);
        }).then((response) => {
            try {
                response.data = JSON.parse(response.data);
                return response;
            } catch (e) {
            }
            if (response.status === 200) {
                this.$throw(0, 'Invalid JSON response');
            }
            this.$throw(res.status);
        }).then(({ data, status }) => {
            if (data === Object(data)) {
                if (status === 200) {
                    if (data.success === Object(data.success)) {
                        new Noty({
                            type: 'success',
                            text: escapeTag(data.success.message)
                        }).show();
                    }
                    return data;
                }
                if (data.error === Object(data.error)) {
                    this.$throw(
                        data.error.status_code || status,
                        data.error.message,
                        data.error.data
                    );
                } else if (typeof data.error === 'string') {
                    this.$throw(
                        data.status_code || status,
                        data.error
                    );
                }
            }
            this.$throw(status, data);
            return data;
        });
        if (isGetRequest === true) {
            req.finally(() => {
                this.pendingGetRequests.delete(init.url);
            });
            this.pendingGetRequests.set(init.url, req);
        }
        return req;
    };

    API.statusCodes = {
        100: 'Continue',
        101: 'Switching Protocols',
        102: 'Processing',
        103: 'Early Hints',
        200: 'OK',
        201: 'Created',
        202: 'Accepted',
        203: 'Non-Authoritative Information',
        204: 'No Content',
        205: 'Reset Content',
        206: 'Partial Content',
        207: 'Multi-Status',
        208: 'Already Reported',
        226: 'IM Used',
        300: 'Multiple Choices',
        301: 'Moved Permanently',
        302: 'Found',
        303: 'See Other',
        304: 'Not Modified',
        305: 'Use Proxy',
        306: 'Switch Proxy',
        307: 'Temporary Redirect',
        308: 'Permanent Redirect',
        400: 'Bad Request',
        401: 'Unauthorized',
        402: 'Payment Required',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        406: 'Not Acceptable',
        407: 'Proxy Authentication Required',
        408: 'Request Timeout',
        409: 'Conflict',
        410: 'Gone',
        411: 'Length Required',
        412: 'Precondition Failed',
        413: 'Payload Too Large',
        414: 'URI Too Long',
        415: 'Unsupported Media Type',
        416: 'Range Not Satisfiable',
        417: 'Expectation Failed',
        418: "I'm a teapot",
        421: 'Misdirected Request',
        422: 'Unprocessable Entity',
        423: 'Locked',
        424: 'Failed Dependency',
        425: 'Too Early',
        426: 'Upgrade Required',
        428: 'Precondition Required',
        429: 'Too Many Requests',
        431: 'Request Header Fields Too Large',
        451: 'Unavailable For Legal Reasons',
        500: 'Internal Server Error',
        501: 'Not Implemented',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
        504: 'Gateway Timeout',
        505: 'HTTP Version Not Supported',
        506: 'Variant Also Negotiates',
        507: 'Insufficient Storage',
        508: 'Loop Detected',
        510: 'Not Extended',
        511: 'Network Authentication Required',
        // CloudFlare Error
        520: 'Web server returns an unknown error',
        521: 'Web server is down',
        522: 'Connection timed out',
        523: 'Origin is unreachable',
        524: 'A timeout occurred',
        525: 'SSL handshake failed',
        526: 'Invalid SSL certificate',
        527: 'Railgun Listener to origin error'
    };

    API.$throw = function (code, error) {
        var text = [];
        if (code > 0) {
            var status = this.statusCodes[code];
            if (status === undefined) {
                text.push(`${code}`);
            } else {
                text.push(`${code} ${status}`);
            }
        }
        if (error !== undefined) {
            text.push(JSON.stringify(error));
        }
        text = text.map((s) => escapeTag(s)).join('<br>');
        if (text.length) {
            new Noty({
                type: 'error',
                text
            }).show();
        }
        throw new Error(text);
    };

    // API: Config

    API.cachedConfig = {};

    API.$on('CONFIG', function (args) {
        args.ref = this.applyConfig(args.json);
    });

    API.applyConfig = function (json) {
        var ref = {
            clientApiKey: '',
            ...json
        };
        this.cachedConfig = ref;
        return ref;
    };

    API.getConfig = function () {
        return this.call('config', {
            method: 'GET'
        }).then((json) => {
            var args = {
                ref: null,
                json
            };
            this.$emit('CONFIG', args);
            return args;
        });
    };

    // API: Location

    API.parseLocation = function (tag) {
        tag = String(tag || '');
        var ctx = {
            tag,
            isOffline: false,
            isPrivate: false,
            worldId: '',
            instanceId: '',
            instanceName: '',
            accessType: '',
            userId: null,
            hiddenId: null,
            privateId: null,
            friendsId: null,
            canRequestInvite: false
        };
        if (tag === 'offline') {
            ctx.isOffline = true;
        } else if (tag === 'private') {
            ctx.isPrivate = true;
        } else if (tag.startsWith('local') === false) {
            var sep = tag.indexOf(':');
            if (sep >= 0) {
                ctx.worldId = tag.substr(0, sep);
                ctx.instanceId = tag.substr(sep + 1);
                ctx.instanceId.split('~').forEach((s, i) => {
                    if (i) {
                        var A = s.indexOf('(');
                        var Z = A >= 0
                            ? s.lastIndexOf(')')
                            : -1;
                        var key = Z >= 0
                            ? s.substr(0, A)
                            : s;
                        var value = A < Z
                            ? s.substr(A + 1, Z - A - 1)
                            : '';
                        if (key === 'hidden') {
                            ctx.hiddenId = value;
                        } else if (key === 'private') {
                            ctx.privateId = value;
                        } else if (key === 'friends') {
                            ctx.friendsId = value;
                        } else if (key === 'canRequestInvite') {
                            ctx.canRequestInvite = true;
                        }
                    } else {
                        ctx.instanceName = s;
                    }
                });
                ctx.accessType = 'public';
                if (ctx.privateId !== null) {
                    if (ctx.canRequestInvite) {
                        // InvitePlus
                        ctx.accessType = 'invite+';
                    } else {
                        // InviteOnly
                        ctx.accessType = 'invite';
                    }
                    ctx.userId = ctx.privateId;
                } else if (ctx.friendsId !== null) {
                    // FriendsOnly
                    ctx.accessType = 'friends';
                    ctx.userId = ctx.friendsId;
                } else if (ctx.hiddenId !== null) {
                    // FriendsOfGuests
                    ctx.accessType = 'friends+';
                    ctx.userId = ctx.hiddenId;
                }
            } else {
                ctx.worldId = tag;
            }
        }
        return ctx;
    };

    Vue.component('location', {
        template: '<span>{{ text }}<slot></slot></span>',
        props: {
            location: String
        },
        data() {
            return {
                text: this.location
            };
        },
        methods: {
            parse() {
                var L = API.parseLocation(this.location);
                if (L.isOffline) {
                    this.text = 'Offline';
                } else if (L.isPrivate) {
                    this.text = 'Private';
                } else if (L.worldId) {
                    var ref = API.cachedWorlds.get(L.worldId);
                    if (ref === undefined) {
                        API.getWorld({
                            worldId: L.worldId
                        }).then((args) => {
                            if (L.tag === this.location) {
                                if (L.instanceId) {
                                    this.text = `${args.json.name} #${L.instanceName} ${L.accessType}`;
                                } else {
                                    this.text = args.json.name;
                                }
                            }
                            return args;
                        });
                    } else if (L.instanceId) {
                        this.text = `${ref.name} #${L.instanceName} ${L.accessType}`;
                    } else {
                        this.text = ref.name;
                    }
                }
            }
        },
        watch: {
            location() {
                this.parse();
            }
        },
        created() {
            this.parse();
        }
    });

    // API: World

    API.cachedWorlds = new Map();

    API.$on('WORLD', function (args) {
        args.ref = this.applyWorld(args.json);
    });

    API.applyWorld = function (json) {
        var ref = this.cachedWorlds.get(json.id);
        if (ref === undefined) {
            ref = {
                id: '',
                name: '',
                description: '',
                authorId: '',
                authorName: '',
                capacity: 0,
                tags: [],
                releaseStatus: '',
                imageUrl: '',
                thumbnailImageUrl: '',
                assetUrl: '',
                assetUrlObject: {},
                pluginUrl: '',
                pluginUrlObject: {},
                unityPackageUrl: '',
                unityPackageUrlObject: {},
                unityPackages: [],
                version: 0,
                favorites: 0,
                created_at: '',
                updated_at: '',
                publicationDate: '',
                labsPublicationDate: '',
                visits: 0,
                popularity: 0,
                heat: 0,
                publicOccupants: 0,
                privateOccupants: 0,
                occupants: 0,
                instances: [],
                // VRCX
                $isLabs: false,
                //
                ...json
            };
            this.cachedWorlds.set(ref.id, ref);
        } else {
            Object.assign(ref, json);
        }
        ref.$isLabs = ref.tags.includes('system_labs');
        return ref;
    };

    /*
        params: {
            worldId: string
        }
    */
    API.getWorld = function (params) {
        return this.call(`worlds/${params.worldId}`, {
            method: 'GET'
        }).then((json) => {
            var args = {
                ref: null,
                json,
                params
            };
            this.$emit('WORLD', args);
            return args;
        });
    };

    var $app = {
        data: {
            API,
            // 1 = 대시보드랑 손목에 보이는거
            // 2 = 항상 화면에 보이는 거
            appType: location.href.substr(-1),
            currentTime: new Date().toJSON(),
            currentUserStatus: null,
            cpuUsage: 0,
            nowPlayingobj: {},
            newPlayingobj: {
                videoURL: '',
                videoName: '',
                videoVolume: '',
                videoChangeTime: ''
            },
            worldJoinTime: '',
            isGameRunning: false,
            lastLocation: '',
            lastFeedEntry: [],
            feedFilters: [],
            wristFeed: [],
            notyMap: [],
            devices: [],
            overlayNotificationsToggle: false,
            notificationTTSToggle: false,
            notificationTTSVoice: '0',
            hideDevicesToggle: false,
            isMinimalFeed: false,
            notificationPosition: 'topCenter',
            notificationTimeout: '3000',
            notificationTheme: 'relax'
        },
        computed: {},
        methods: {},
        watch: {},
        el: '#x-app',
        mounted() {
            // https://media.discordapp.net/attachments/581757976625283083/611170278218924033/unknown.png
            // 현재 날짜 시간
            // 컨트롤러 배터리 상황
            // --
            // OO is in Let's Just H!!!!! [GPS]
            // OO has logged in [Online] -> TODO: location
            // OO has logged out [Offline] -> TODO: location
            // OO has joined [OnPlayerJoined]
            // OO has left [OnPlayerLeft]
            // [Moderation]
            // OO has blocked you
            // OO has muted you
            // OO has hidden you
            // --
            API.getConfig().catch((err) => {
                // FIXME: 어케 복구하냐 이건
                throw err;
            }).then((args) => {
                this.initConfigVars();
                this.initNotyMap();
                this.updateLoop();
                this.updateCpuUsageLoop();
                this.$nextTick(function () {
                    if (this.appType === '1') {
                        this.$el.style.display = '';
                    }
                });
                return args;
            });
        }
    };

    $app.methods.initConfigVars = function () {
        this.notificationTTSToggle = configRepository.getBool('VRCX_notificationTTS');
        this.notificationTTSVoice = configRepository.getString('VRCX_notificationTTSVoice');
        this.overlayNotificationsToggle = configRepository.getBool('VRCX_overlayNotifications');
        this.hidePrivateFromFeed = configRepository.getBool('VRCX_hidePrivateFromFeed');
        this.hideDevicesToggle = configRepository.getBool('VRCX_hideDevicesFromFeed');
        this.isMinimalFeed = configRepository.getBool('VRCX_minimalFeed');
        this.feedFilters = JSON.parse(configRepository.getString('sharedFeedFilters'));
        this.notificationPosition = configRepository.getString('VRCX_notificationPosition');
        this.notificationTimeout = configRepository.getString('VRCX_notificationTimeout');
        if (configRepository.getBool('isDarkMode')) {
            this.notificationTheme = 'sunset';
        } else {
            this.notificationTheme = 'relax';
        }
    };

    $app.methods.initNotyMap = function () {
        var feeds = sharedRepository.getArray('feeds');
        if (feeds === null) {
            return;
        }
        var filter = this.feedFilters.noty;
        var filtered = [];
        feeds.forEach((feed) => {
            if (filter[feed.type]) {
                if ((filter[feed.type] !== 'Off') &&
                    ((filter[feed.type] === 'Everyone') || (filter[feed.type] === 'On') ||
                    ((filter[feed.type] === 'Friends') && (feed.isFriend)) ||
                    ((filter[feed.type] === 'VIP') && (feed.isFavorite)))) {
                    var displayName = '';
                    if (feed.data) {
                        displayName = feed.data;
                    } else if (feed.displayName) {
                        displayName = feed.displayName;
                    } else if (feed.senderUsername) {
                        displayName = feed.senderUsername;
                    }
                    if ((displayName) && (!this.notyMap[displayName]) ||
                        (this.notyMap[displayName] < feed.created_at)) {
                        this.notyMap[displayName] = feed.created_at;
                    }
                }
            }
        });
    };

    $app.methods.updateLoop = async function () {
        try {
            this.currentTime = new Date().toJSON();
            this.currentUserStatus = sharedRepository.getString('current_user_status');
            this.isGameRunning = sharedRepository.getBool('is_game_running');
            this.lastLocation = sharedRepository.getString('last_location');
            if (!this.hideDevicesToggle) {
                AppApi.GetVRDevices().then((devices) => {
                    devices.forEach((device) => {
                        device[2] = parseInt(device[2], 10);
                    });
                    this.devices = devices;
                });
            } else {
                this.devices = '';
            }
            await this.updateSharedFeeds();
        } catch (err) {
            console.error(err);
        }
        setTimeout(() => this.updateLoop(), 500);
    };

    $app.methods.updateCpuUsageLoop = async function () {
        try {
            var cpuUsage = await AppApi.CpuUsage();
            this.cpuUsage = cpuUsage.toFixed(0);
        } catch (err) {
            console.error(err);
        }
        setTimeout(() => this.updateCpuUsageLoop(), 1000);
    };

    $app.methods.updateSharedFeeds = async function () {
        var feeds = sharedRepository.getArray('feeds');
        if (feeds === null) {
            return;
        }
        this.updateSharedFeedVideo(feeds);
        if ((this.lastFeedEntry !== undefined) &&
            (feeds[0].created_at === this.lastFeedEntry.created_at)) {
            return;
        }
        this.lastFeedEntry = feeds[0];

        // OnPlayerJoining
        var bias = new Date(Date.now() - 120000).toJSON();
        for (i = 0; i < feeds.length; i++) {
            var ctx = feeds[i];
            if ((ctx.created_at < bias) || (ctx.type === 'Location')) {
                break;
            }
            if ((ctx.type === 'GPS') && (ctx.location[0] === this.lastLocation)) {
                var joining = true;
                for (var k = 0; k < feeds.length; k++) {
                    var feedItem = feeds[k];
                    if ((feedItem.type === 'OnPlayerJoined') && (feedItem.data === ctx.displayName)) {
                        joining = false;
                        break;
                    }
                    if ((feedItem.created_at < bias) || (feedItem.type === 'Location') ||
                        ((feedItem.type === 'GPS') && (feedItem.location !== ctx.location[0]) &&
                        (feedItem.displayName === ctx.displayName))) {
                        break;
                    }
                }
                if (joining) {
                    var onPlayerJoining = {};
                    onPlayerJoining.created_at = ctx.created_at;
                    onPlayerJoining.data = ctx.displayName;
                    onPlayerJoining.isFavorite = ctx.isFavorite;
                    onPlayerJoining.isFriend = ctx.isFriend;
                    onPlayerJoining.type = 'OnPlayerJoining';
                    feeds.splice(i, 0, onPlayerJoining);
                    i++;
                }
            }
        }

        if (this.hidePrivateFromFeed) {
            for (var i = 0; i < feeds.length; i++) {
                var feed = feeds[i];
                if ((feed.type === 'GPS') && (feed.location[0] === 'private')) {
                    feeds.splice(i, 1);
                    i--;
                }
            }
        }

        if (this.appType === '1') {
            this.updateSharedFeedWrist(feeds);
        }
        if (this.appType === '2') {
            this.updateSharedFeedNoty(feeds);
        }
    };

    $app.methods.updateSharedFeedWrist = async function (feeds) {
        var filter = this.feedFilters.wrist;
        var filtered = [];
        feeds.forEach((feed) => {
            if (filter[feed.type]) {
                if ((filter[feed.type] !== 'Off') &&
                    ((filter[feed.type] === 'Everyone') || (filter[feed.type] === 'On') ||
                    ((filter[feed.type] === 'Friends') && (feed.isFriend)) ||
                    ((filter[feed.type] === 'VIP') && (feed.isFavorite)))) {
                    filtered.push(feed);
                }
            } else {
                console.error(`missing feed filter for ${feed.type}`);
                filtered.push(feed);
            }
        });
        this.wristFeed = filtered;
    };

    $app.methods.updateSharedFeedNoty = async function (feeds) {
        var filter = this.feedFilters.noty;
        var filtered = [];
        feeds.forEach((feed) => {
            if (filter[feed.type]) {
                if ((filter[feed.type] !== 'Off') &&
                    ((filter[feed.type] === 'Everyone') || (filter[feed.type] === 'On') ||
                    ((filter[feed.type] === 'Friends') && (feed.isFriend)) ||
                    ((filter[feed.type] === 'VIP') && (feed.isFavorite)))) {
                    filtered.push(feed);
                }
            }
        });
        var notyToPlay = [];
        filtered.forEach((feed) => {
            var displayName = '';
            if (feed.displayName) {
                displayName = feed.displayName;
            } else if (feed.senderUsername) {
                displayName = feed.senderUsername;
            } else if (feed.data) {
                displayName = feed.data;
            } else {
                console.error('missing displayName');
            }
            if ((displayName) && (!this.notyMap[displayName]) ||
                (this.notyMap[displayName] < feed.created_at)) {
                this.notyMap[displayName] = feed.created_at;
                notyToPlay.push(feed);
            }
        });

        // disable notifications when busy or game isn't running
        if ((this.currentUserStatus === 'busy') || (!this.isGameRunning)) {
            return;
        }
        notyToPlay.forEach(async (noty) => {
            if (this.overlayNotificationsToggle) {
                var text = '';
                switch (noty.type) {
                    case 'OnPlayerJoined':
                        text = `<strong>${noty.data}</strong> has joined`;
                        break;
                    case 'OnPlayerLeft':
                        text = `<strong>${noty.data}</strong> has left`;
                        break;
                    case 'OnPlayerJoining':
                        text = `<strong>${noty.data}</strong> is joining`;
                        break;
                    case 'GPS':
                        text = '<strong>' + noty.displayName + '</strong> is in ' + await this.displayLocation(noty.location[0]);
                        break;
                    case 'Online':
                        text = `<strong>${noty.displayName}</strong> has logged in`;
                        break;
                    case 'Offline':
                        text = `<strong>${noty.displayName}</strong> has logged out`;
                        break;
                    case 'Status':
                        text = `<strong>${noty.displayName}</strong> status is now <i>${noty.status[0].status}</i> ${noty.status[0].statusDescription}`;
                        break;
                    case 'invite':
                        text = `<strong>${noty.senderUsername}</strong> has invited you to ${noty.details.worldName}`;
                        break;
                    case 'requestInvite':
                        text = `<strong>${noty.senderUsername}</strong> has requested an invite`;
                        break;
                    case 'friendRequest':
                        text = `<strong>${noty.senderUsername}</strong> has sent you a friend request`;
                        break;
                    case 'Friend':
                        text = `<strong>${noty.displayName}</strong> is now your friend`;
                        break;
                    case 'Unfriend':
                        text = `<strong>${noty.displayName}</strong> has unfriended you`;
                        break;
                    case 'TrustLevel':
                        text = `<strong>${noty.displayName}</strong> trust level is now ${noty.trustLevel}`;
                        break;
                    case 'DisplayName':
                        text = `<strong>${noty.previousDisplayName}</strong> changed their name to ${noty.displayName}`;
                        break;
                }
                if (text) {
                    new Noty({
                        type: 'alert',
                        theme: this.notificationTheme,
                        timeout: this.notificationTimeout,
                        layout: this.notificationPosition,
                        text: text
                    }).show();
                }
            }
            if (this.notificationTTSToggle) {
                switch (noty.type) {
                    case 'OnPlayerJoined':
                        this.speak(`${noty.data} has joined`);
                        break;
                    case 'OnPlayerLeft':
                        this.speak(`${noty.data} has left`);
                        break;
                    case 'OnPlayerJoining':
                        this.speak(`${noty.data} is joining`);
                        break;
                    case 'GPS':
                        this.speak(noty.displayName + ' is in ' + await this.displayLocation(noty.location[0]));
                        break;
                    case 'Online':
                        this.speak(`${noty.displayName} has logged in`);
                        break;
                    case 'Offline':
                        this.speak(`${noty.displayName} has logged out`);
                        break;
                    case 'Status':
                        this.speak(`${noty.displayName} status is now ${noty.status[0].status} ${noty.status[0].statusDescription}`);
                        break;
                    case 'invite':
                        this.speak(`${noty.senderUsername} has invited you to ${noty.details.worldName}`);
                        break;
                    case 'requestInvite':
                        this.speak(`${noty.senderUsername} has requested an invite`);
                        break;
                    case 'friendRequest':
                        this.speak(`${noty.senderUsername} has sent you a friend request`);
                        break;
                    case 'Friend':
                        this.speak(`${noty.displayName} is now your friend`);
                        break;
                    case 'Unfriend':
                        this.speak(`${noty.displayName} has unfriended you`);
                        break;
                    case 'TrustLevel':
                        this.speak(`${noty.displayName} trust level is now ${noty.trustLevel}`);
                        break;
                    case 'DisplayName':
                        this.speak(`${noty.previousDisplayName} changed their name to ${noty.displayName}`);
                        break;
                }
            }
        });
    };

    $app.methods.updateSharedFeedVideo = async function (feeds) {
        this.nowPlayingobj.videoProgressText = '';
        var locationChange = false;
        var videoChange = false;
        feeds.forEach((feed) => {
            if ((feed.type === "Location") && (locationChange === false)) {
                locationChange = true;
                this.worldJoinTime = feed.created_at;
            }
            else if ((feed.type === "VideoChange") && (videoChange === false)) {
                videoChange = true
                this.newPlayingobj = feed.data;
                this.newPlayingobj.videoChangeTime = feed.created_at;
            }
        });
        if (this.newPlayingobj.videoURL != '') {
            var percentage = 0;
            var videoLength = Number(this.newPlayingobj.videoLength) + 9; //9 magic number
            var currentTime = Date.now() / 1000;
            var videoStartTime = videoLength + Date.parse(this.newPlayingobj.videoChangeTime) / 1000;
            var videoProgress = Math.floor((videoStartTime - currentTime) * 100) / 100;
            if ((Date.parse(this.newPlayingobj.videoChangeTime) / 1000) < (Date.parse(this.worldJoinTime) / 1000)) {
                videoProgress = -60;
            }
            if ((videoProgress > 0) && (this.isGameRunning)) {
                function sec2time(timeInSeconds) {
                    var pad = function(num, size) { return ('000' + num).slice(size * -1); },
                    time = parseFloat(timeInSeconds).toFixed(3),
                    hours = Math.floor(time / 60 / 60),
                    minutes = Math.floor(time / 60) % 60,
                    seconds = Math.floor(time - minutes * 60);
                    var hoursOut = "";
                    if (hours > "0") { hoursOut = pad(hours, 2) + ':' }
                    return hoursOut + pad(minutes, 2) + ':' + pad(seconds, 2);
                }
                this.nowPlayingobj.videoProgressText = sec2time(videoProgress);
                percentage = Math.floor((((videoLength - videoProgress) * 100) / videoLength) * 100) / 100;
            }
            else {
                this.newPlayingobj = {
                    videoURL: '',
                    videoName: '',
                    videoVolume: ''
                };
            }
            if (videoProgress <= -60) {
                Discord.SetActive(false);
                Discord.SetText('', '');
            }
        }
        if (this.nowPlayingobj.videoURL !== this.newPlayingobj.videoURL)  {
            this.nowPlayingobj = this.newPlayingobj;
            if (this.appType === '2') {
                if (this.nowPlayingobj.videoURL != '') {
                    if (configRepository.getBool('VRCX_videoNotification')) {
                        if (this.newPlayingobj.playerPlayer !== '') {
                            new Noty({
                                type: 'alert',
                                theme: this.notificationTheme,
                                timeout: this.notificationTimeout,
                                layout: this.notificationPosition,
                                text: 'Requested by: ' + this.newPlayingobj.playerPlayer
                            }).show();
                        }
                        new Noty({
                            type: 'alert',
                            theme: this.notificationTheme,
                            timeout: this.notificationTimeout,
                            layout: this.notificationPosition,
                            text: this.newPlayingobj.videoName
                        }).show();
                    }
                    if (configRepository.getBool('VRCX_notificationTTS')) {
                        var ttsURL = '';
                        if (this.newPlayingobj.videoID == 'YouTube') { ttsURL = 'URL' }
                        var ttsRequestedBy = '';
                        if (this.newPlayingobj.playerPlayer !== '') { ttsRequestedBy = 'Requested by ' + this.newPlayingobj.playerPlayer; }
                        this.speak(`now playing ${ttsURL} ${this.newPlayingobj.videoName} ${ttsRequestedBy}`);
                    }
                    if (configRepository.getBool('discordActive')) {
                        var requestedBy = '';
                        if (this.newPlayingobj.playerPlayer !== '') { requestedBy = 'Requested by: ' + this.newPlayingobj.playerPlayer; }
                        Discord.SetText('Video: ' + this.newPlayingobj.videoName, requestedBy);
                        Discord.SetAssets('pypy', 'https://github.com/Natsumi-sama/VRCX', 'ayaya', 'Clap');
                        Discord.SetTimestamps(Date.now(), Date.parse(this.newPlayingobj.videoChangeTime) + Number(videoLength) * 1000);
                        Discord.SetActive(true);
                    }
                }
                if (configRepository.getBool('VRCX_volumeNormalize') == true) {
                    if (this.newPlayingobj.videoVolume != '') {
                        var mindB = "-10.0";
                        var maxdB = "-24.0";
                        var minVolume = "30";
                        var dBpercenatge = ((this.newPlayingobj.videoVolume - mindB) * 100) / (maxdB - mindB);
                        if (dBpercenatge > 100) { dBpercenatge = 100; }
                        else if (dBpercenatge < 0) { dBpercenatge = 0; }
                        var newPercenatge = ((minVolume / 43) * dBpercenatge) + Number(minVolume);
                        var mixerVolume = newPercenatge / 100.0;
                        var mixerVolumeFloat = mixerVolume.toFixed(2);
                    }
                    else {
                        var mixerVolumeFloat = "0.50";
                    }
                    AppApi.ChangeVolume(mixerVolumeFloat);
                }
            }
        }
        if (this.appType === '2') {
            if (configRepository.getBool('VRCX_progressPie') == true) {
                bar.animate(parseFloat(percentage) / 100.0);
            }
            else {
                bar.animate(0);
            }
        }
        else {
            document.getElementById("progress").style.width = percentage + "%";
        }
    };

    $app.methods.userStatusClass = function (user) {
        var style = {};
        if (user) {
            if (user.location === 'offline') {
                style.offline = true;
            } else if (user.status === 'active') {
                style.active = true;
            } else if (user.status === 'join me') {
                style.joinme = true;
            } else if (user.status === 'busy') {
                style.busy = true;
            }
        }
        return style;
    };

    $app.methods.displayLocation = async function (location) {
        var text = '';
        var L = API.parseLocation(location);
        if (L.isOffline) {
            text = 'Offline';
        } else if (L.isPrivate) {
            text = 'Private';
        } else if (L.worldId) {
            var ref = API.cachedWorlds.get(L.worldId);
            if (ref === undefined) {
                await API.getWorld({
                    worldId: L.worldId
                }).then((args) => {
                    if (L.tag === location) {
                        if (L.instanceId) {
                            text = `${args.json.name} ${L.accessType}`;
                        } else {
                            text = args.json.name;
                        }
                    }
                });
            } else if (L.instanceId) {
                text = `${ref.name} ${L.accessType}`;
            } else {
                text = ref.name;
            }
        }
        return text;
    };

    $app.methods.speak = function (text) {
        var tts = new SpeechSynthesisUtterance();
        var voices = speechSynthesis.getVoices();
        var voiceIndex = this.notificationTTSVoice;
        tts.voice = voices[voiceIndex];
        tts.text = text;
        speechSynthesis.speak(tts);
    };

    $app = new Vue($app);
    window.$app = $app;
})();
