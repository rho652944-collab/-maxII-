/* SillyTavern / SillyDroid Intiface Safe Sequence
 * Local safety-focused replacement for the community ST-Intiface-Plugin.
 * Supports multiple ordered <toy ... /> steps in one completed AI reply.
 */
(() => {
    'use strict';

    const PLUGIN_NAME = 'IntifaceSafeSequence';
    const PLUGIN_VERSION = '1.3.0';
    const SETTINGS_KEY = 'intiface_safe_sequence_settings';

    // Hard safety limits: these are enforced in code, not supplied by the model.
    const LIMITS = Object.freeze({
        defaultIntensity: 0.10,
        idleIntensity: 0.20,
        maxIntensity: 0.80,
        defaultDurationMs: 1000,
        minDurationMs: 250,
        maxDurationMs: 2000,
        maxActionsPerReply: 8,
        maxRunDurationMs: 35000,
        gapBetweenActionsMs: 300,
    });

    const DEFAULT_SETTINGS = Object.freeze({
        serverAddress: 'ws://192.168.31.19:12345',
        enabled: false,
        autoConnect: false,
    });

    let settings = { ...DEFAULT_SETTINGS };
    let ws = null;
    let connected = false;
    let serverReady = false;
    let devices = new Map();
    let nextId = 1;
    const pending = new Map();
    let currentRunId = 0;
    let lastProcessedKey = '';
    let getContextFn = null;
    let eventSource = null;
    let eventTypes = null;
    let controlMode = 'stopped';
    let runTimer = null;
    let stepTimer = null;
    let pingTimer = null;
    let generation = null;
    let completionTimer = null;
    let generationEventsReady = false;
    let connectionAttempt = null;
    const now = () => performance.now();

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const finiteNumber = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };

    function log(message, level = 'info') {
        const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const line = `[${stamp}] ${message}`;
        if (level === 'error') console.error(`[Intiface Safe] ${line}`);
        else if (level === 'warn') console.warn(`[Intiface Safe] ${line}`);
        else console.log(`[Intiface Safe] ${line}`);

        const box = $('#ifs-log');
        if (box.length) {
            const color = level === 'error' ? '#ff7777' : level === 'warn' ? '#ffd166' : '#8ee6a8';
            $('<div>').text(line).css({ color, padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }).appendTo(box);
            while (box.children().length > 50) box.children().first().remove();
            box.scrollTop(box[0].scrollHeight);
        }
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    }

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            settings = { ...DEFAULT_SETTINGS, ...saved };
        } catch (_) {
            settings = { ...DEFAULT_SETTINGS };
        }
        // Never load model-adjustable or legacy strength/duration settings.
        settings.serverAddress = String(settings.serverAddress || DEFAULT_SETTINGS.serverAddress);
        settings.enabled = settings.enabled === true;
        settings.autoConnect = settings.autoConnect === true;
    }

    function initUI() {
        const html = `
        <div class="inline-drawer" id="intiface-safe-sequence-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>玩具控制器 · 安全序列版 <span style="font-size:11px;opacity:.6">v${PLUGIN_VERSION}</span></b>
            <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content" style="display:none">
            <div class="if-body">
              <div class="if-section">
                <div class="if-section-title">连接管理</div>
                <div class="if-connection-row">
                  <span class="if-status-dot" id="ifs-status-dot"></span>
                  <span class="if-status-text" id="ifs-status-text">未连接</span>
                </div>
                <input class="if-input" id="ifs-server-address" value="${settings.serverAddress}" />
                <div class="if-btn-group">
                  <button class="if-btn if-btn-primary" id="ifs-connect">连接</button>
                  <button class="if-btn if-btn-danger" id="ifs-disconnect" style="display:none">断开</button>
                </div>
                <div id="ifs-devices" style="margin-top:10px;font-size:13px">尚未发现设备</div>
              </div>
              <div class="if-section">
                <div class="if-section-title">AI 自动控制</div>
                <div class="if-setting-row">
                  <span>启用自动控制及默认 20% 震动</span>
                  <input type="checkbox" id="ifs-enabled" ${settings.enabled ? 'checked' : ''}/>
                </div>
                <div class="if-setting-row">
                  <span>启动时自动连接</span>
                  <input type="checkbox" id="ifs-autoconnect" ${settings.autoConnect ? 'checked' : ''}/>
                </div>
                <div style="font-size:12px;line-height:1.6;opacity:.85">
                  每条 AI 回复最多 ${LIMITS.maxActionsPerReply} 个动作；单动作最长 ${LIMITS.maxDurationMs / 1000} 秒；
                  AI 动作按顺序循环，最长 ${LIMITS.maxRunDurationMs / 1000} 秒后恢复默认 20% 震动并关闭气泵。
                  输入、发送和等待回复时保持默认震动；强度硬上限 ${Math.round(LIMITS.maxIntensity * 100)}%。
                  默认震动持续至明确停止或关闭自动控制。手动测试只执行一次。
                </div>
                <div id="ifs-mode" style="margin-top:8px;font-size:13px">已停止</div>
              </div>
              <div class="if-section">
                <div class="if-section-title">手动低强度测试</div>
                <div class="if-btn-group">
                  <button class="if-btn if-btn-secondary" id="ifs-test-vibrate">震动测试 10%</button>
                  <button class="if-btn if-btn-secondary" id="ifs-test-suck">气泵测试 10%</button>
                </div>
              </div>
              <div class="if-section">
                <button class="if-btn if-btn-danger" id="ifs-stop" style="width:100%">紧急停止所有设备</button>
              </div>
              <div class="if-section">
                <div class="if-section-title">运行日志</div>
                <div id="ifs-log" style="background:rgba(0,0,0,.25);padding:8px;height:120px;overflow:auto;font:11px monospace;border-radius:5px"></div>
              </div>
            </div>
          </div>
        </div>`;

        if (!$('#intiface-safe-sequence-drawer').length) {
            $('#extensions_settings').append(html);
            // SillyTavern/SillyDroid already handles .inline-drawer-toggle clicks.
            // Do not bind a second toggle handler here: it would open and immediately close the drawer.
            $('#ifs-connect').on('click', () => {
                settings.serverAddress = String($('#ifs-server-address').val() || '').trim();
                saveSettings();
                connectToServer().catch(err => log(`连接失败：${String(err)}`, 'error'));
            });
            $('#ifs-disconnect').on('click', () => disconnectFromServer());
            $('#ifs-stop').on('click', () => cancelSequence('用户紧急停止'));
            $('#ifs-enabled').on('change', function () {
                settings.enabled = $(this).prop('checked');
                saveSettings();
                if (!settings.enabled) cancelSequence('自动控制已关闭');
                else returnToBaseline('自动控制已启用，默认震动 20%');
                log(settings.enabled ? 'AI 自动控制已启用' : 'AI 自动控制已关闭');
            });
            $('#ifs-autoconnect').on('change', function () {
                settings.autoConnect = $(this).prop('checked');
                saveSettings();
            });
            $('#ifs-test-vibrate').on('click', () => runSequence([{ vibrate: 0.10, duration: 700 }], '手动震动测试'));
            $('#ifs-test-suck').on('click', () => runSequence([{ suck: 0.10, duration: 700 }], '手动气泵测试'));
            $(document).on('input.intifaceSafe', '#send_textarea', () => {
                if (controlMode === 'sequence') returnToBaseline('开始输入，恢复默认震动');
            });
        }
        $('#ifs-server-address').val(settings.serverAddress);
        $('#ifs-enabled').prop('checked', settings.enabled);
        $('#ifs-autoconnect').prop('checked', settings.autoConnect);
        updateConnectionUI();
        updateDevicesUI();
    }

    function updateConnectionUI() {
        $('#ifs-status-dot').css({
            background: connected ? '#22c55e' : '#ef4444',
            boxShadow: connected ? '0 0 8px rgba(34,197,94,.6)' : '0 0 8px rgba(239,68,68,.5)',
        });
        $('#ifs-status-text').text(connected ? (serverReady ? '已连接 Intiface' : '已连接，正在握手') : '未连接');
        $('#ifs-connect').toggle(!connected);
        $('#ifs-disconnect').toggle(connected);
    }

    function updateDevicesUI() {
        const el = $('#ifs-devices');
        if (!el.length) return;
        if (!devices.size) {
            el.text('尚未发现设备');
            return;
        }
        const lines = [];
        for (const [index, device] of devices) {
            const caps = getCapabilities(device);
            const labels = [];
            if (caps.some(c => c.type === 'Vibrate') || device.DeviceMessages?.VibrateCmd) labels.push('震动');
            if (caps.some(c => c.type === 'Constrict' || c.type === 'Oscillate')) labels.push('气泵');
            lines.push(`${device.DeviceName || '设备'} #${index}（${labels.join('、') || '未识别控制能力'}）`);
        }
        el.text(lines.join('\n'));
    }

    function nextMessageId() { return nextId++; }

    function sendMessage(message, timeoutMs = 5000) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Intiface WebSocket 未连接'));
        const key = Object.keys(message)[0];
        const id = message[key].Id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Buttplug 请求超时：${key}`));
            }, timeoutMs);
            pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            try {
                ws.send(JSON.stringify([message]));
            } catch (error) {
                clearTimeout(timer);
                pending.delete(id);
                reject(error);
            }
        });
    }

    function handleServerInfo(info) {
        serverReady = true;
        log('Intiface 握手成功');
        clearInterval(pingTimer);
        if (Number(info.MaxPingTime) > 0) {
            const socket = ws;
            pingTimer = setInterval(() => {
                if (ws !== socket || !serverReady) return;
                sendMessage({ Ping: { Id: nextMessageId() } }, Number(info.MaxPingTime))
                    .catch(error => {
                        if (ws === socket) cancelSequence('连接心跳失败：' + error.message);
                    });
            }, Math.max(1, Math.floor(info.MaxPingTime / 2)));
        }
        updateConnectionUI();
        sendMessage({ RequestDeviceList: { Id: nextMessageId() } })
            .catch(error => cancelSequence('读取设备失败：' + error.message));
        sendMessage({ StartScanning: { Id: nextMessageId() } })
            .catch(error => log(error.message, 'warn'));
    }

    function handleServerMessage(data) {
        let messages;
        try {
            messages = JSON.parse(data);
            if (!Array.isArray(messages)) throw new Error('消息格式错误');
        } catch (error) {
            cancelSequence('无法解析服务器消息：' + error.message);
            return;
        }
        for (const message of messages) {
            const type = Object.keys(message)[0];
            const body = message[type];
            if (!body) continue;
            const item = pending.get(body.Id);
            if (item) {
                pending.delete(body.Id);
                if (type === 'Error') item.reject(new Error(body.ErrorMessage || 'Buttplug 错误'));
                else item.resolve(body);
            }
            if (type === 'ServerInfo') {
                handleServerInfo(body);
            } else if (type === 'DeviceList') {
                devices.clear();
                for (const device of (body.Devices || [])) devices.set(device.DeviceIndex, device);
                updateDevicesUI();
                if (settings.enabled) returnToBaseline('设备已就绪，默认震动 20%', true);
            } else if (type === 'DeviceAdded') {
                devices.set(body.DeviceIndex, body);
                log('发现设备：' + (body.DeviceName || body.DeviceIndex));
                updateDevicesUI();
                if (settings.enabled) returnToBaseline('设备已就绪，默认震动 20%', true);
            } else if (type === 'DeviceRemoved') {
                devices.delete(body.DeviceIndex);
                updateDevicesUI();
                cancelSequence('设备断开，请重新启用自动控制后恢复');
            } else if (type === 'Error' && !item) {
                cancelSequence(body.ErrorMessage || '服务器返回错误');
            }
        }
    }

    function connectToServer() {
        if (connectionAttempt) return connectionAttempt;
        if (connected) return Promise.resolve();
        if (!/^wss?:\/\//.test(settings.serverAddress)) {
            return Promise.reject(new Error('地址必须以 ws:// 或 wss:// 开头'));
        }
        connectionAttempt = new Promise((resolve, reject) => {
            const socket = new WebSocket(settings.serverAddress);
            ws = socket;
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                socket.close();
                reject(new Error('连接或握手超时'));
            }, 7000);
            socket.onopen = () => {
                if (ws !== socket) return;
                connected = true;
                updateConnectionUI();
                sendMessage({
                    RequestServerInfo: {
                        Id: nextMessageId(),
                        ClientName: PLUGIN_NAME,
                        MessageVersion: 3,
                    },
                }).then(() => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    resolve();
                }).catch(error => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    socket.close();
                    reject(error);
                });
            };
            socket.onmessage = event => {
                if (ws === socket) handleServerMessage(event.data);
            };
            socket.onerror = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    socket.close();
                    reject(new Error('WebSocket 连接失败，请检查 Intiface 地址'));
                }
            };
            socket.onclose = () => {
                if (ws !== socket) return;
                connected = false;
                serverReady = false;
                clearInterval(pingTimer);
                for (const item of pending.values()) item.reject(new Error('连接已关闭'));
                pending.clear();
                devices.clear();
                cancelSequence('Intiface 连接已关闭，请重新启用自动控制后恢复');
                updateConnectionUI();
                updateDevicesUI();
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(new Error('连接已关闭'));
                }
            };
        }).finally(() => { connectionAttempt = null; });
        return connectionAttempt;
    }

    async function disconnectFromServer() {
        const socket = ws;
        await cancelSequence('断开连接');
        if (socket) socket.close();
    }

    function getCapabilities(device) {
        if (!device?.DeviceMessages) return [];
        const result = [];
        const scalar = device.DeviceMessages.ScalarCmd;
        if (Array.isArray(scalar)) {
            scalar.forEach((feature, index) => result.push({
                type: feature.ActuatorType,
                index,
                cmdType: 'ScalarCmd',
            }));
        }
        const vibrate = device.DeviceMessages.VibrateCmd;
        if (vibrate && !result.some(item => item.type === 'Vibrate')) {
            const count = Number(vibrate.FeatureCount || 1);
            for (let index = 0; index < count; index++) result.push({ type: 'Vibrate', index, cmdType: 'VibrateCmd' });
        }
        return result;
    }

    async function setActuators(deviceIndex, step, valid = () => true) {
        const device = devices.get(deviceIndex);
        if (!device) return false;
        const caps = getCapabilities(device);
        const scalars = [];
        let legacyVibrate = false;

        if (step.vibrate !== undefined) {
            const vibrators = caps.filter(item => item.type === 'Vibrate' && item.cmdType === 'ScalarCmd');
            if (vibrators.length) {
                for (const item of vibrators) scalars.push({
                    Index: item.index,
                    Scalar: step.vibrate,
                    ActuatorType: 'Vibrate',
                });
            } else if (device.DeviceMessages?.VibrateCmd) {
                legacyVibrate = true;
            }
        }

        if (step.suck !== undefined) {
            const suction = caps.filter(item => item.type === 'Constrict' || item.type === 'Oscillate');
            for (const item of suction) scalars.push({
                Index: item.index,
                Scalar: step.suck,
                ActuatorType: item.type,
            });
        }

        let sent = false;
        if (scalars.length && valid()) {
            await sendMessage({
                ScalarCmd: {
                    Id: nextMessageId(),
                    DeviceIndex: deviceIndex,
                    Scalars: scalars,
                },
            });
            sent = true;
        }
        if (legacyVibrate && valid()) {
            const count = Number(device.DeviceMessages.VibrateCmd.FeatureCount || 1);
            const speeds = Array.from({ length: count }, (_, index) => ({ Index: index, Speed: step.vibrate }));
            await sendMessage({
                VibrateCmd: {
                    Id: nextMessageId(),
                    DeviceIndex: deviceIndex,
                    Speeds: speeds,
                },
            });
            sent = true;
        }
        return sent;
    }

    async function stopAllDevices() {
        if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const socket = ws;
        try {
            await sendMessage({ StopAllDevices: { Id: nextMessageId() } }, 3000);
        } catch (error) {
            log('停止命令未获确认：' + error.message, 'error');
            // A broken stop acknowledgement must never be followed by more motion.
            socket.close();
        }
    }

    function invalidateRun() {
        currentRunId++;
        clearTimeout(runTimer);
        clearTimeout(stepTimer);
        runTimer = null;
        stepTimer = null;
        return currentRunId;
    }

    function setMode(mode) {
        controlMode = mode;
        const labels = {
            stopped: '已停止 · 重新勾选自动控制可恢复',
            baseline: '默认震动 20% · 气泵关闭',
            sequence: '正在执行动作序列',
        };
        $('#ifs-mode').text(labels[mode]);
    }

    async function cancelSequence(reason = '取消当前序列') {
        invalidateRun();
        if (generation) generation.cancelled = true;
        clearTimeout(completionTimer);
        settings.enabled = false;
        saveSettings();
        $('#ifs-enabled').prop('checked', false);
        setMode('stopped');
        log(reason, 'warn');
        await stopAllDevices();
    }

    async function sendStepToDevices(step, runId, valid = () => true) {
        for (const deviceIndex of [...devices.keys()]) {
            if (runId !== currentRunId || !valid()) return;
            await setActuators(deviceIndex, step, () => runId === currentRunId && valid());
        }
    }

    function restStep() {
        return { vibrate: settings.enabled ? LIMITS.idleIntensity : 0, suck: 0 };
    }

    async function returnToBaseline(reason, force = false) {
        if (!settings.enabled || !connected || !serverReady || !devices.size) return;
        if (controlMode === 'baseline' && !force) return;
        const runId = invalidateRun();
        setMode('baseline');
        log(reason);
        try {
            await sendStepToDevices(restStep(), runId);
        } catch (error) {
            if (runId === currentRunId) await cancelSequence('默认震动发送失败：' + error.message);
        }
    }

    function parseAttributes(source) {
        const attrs = {};
        const regex = /([a-zA-Z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
        let match;
        while ((match = regex.exec(source)) !== null) {
            attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? 'true';
        }
        return attrs;
    }

    function parseLevelList(raw) {
        return String(raw).split(',').map(value => Number(value.trim())).filter(value => Number.isFinite(value));
    }

    function parseToyTags(messageText) {
        let text = String(messageText || '');
        if (text.includes('&lt;') || text.includes('&gt;')) {
            const textarea = document.createElement('textarea');
            textarea.innerHTML = text;
            text = textarea.value;
        }

        const parsed = [];
        const regex = /<toy\b([^>]*)\/?>/gi;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            if (Object.prototype.hasOwnProperty.call(attrs, 'stop')) {
                parsed.push({ stop: true });
                break;
            }

            const vibrateValues = attrs.vibrate !== undefined ? parseLevelList(attrs.vibrate) : [];
            const suckValues = attrs.suck !== undefined ? parseLevelList(attrs.suck) : [];
            if (!vibrateValues.length && !suckValues.length) continue;

            const requestedDuration = Math.floor(finiteNumber(attrs.duration, LIMITS.defaultDurationMs));
            const sequenceLength = Math.max(vibrateValues.length, suckValues.length, 1);
            const stepDuration = Math.max(LIMITS.minDurationMs, Math.floor(requestedDuration / sequenceLength));

            for (let index = 0; index < sequenceLength; index++) {
                const step = { duration: stepDuration };
                if (vibrateValues.length) step.vibrate = vibrateValues[Math.min(index, vibrateValues.length - 1)];
                if (suckValues.length) step.suck = suckValues[Math.min(index, suckValues.length - 1)];
                parsed.push(step);
            }
        }
        return parsed;
    }

    function applyHardLimits(parsed) {
        const safe = [];
        for (const original of parsed) {
            if (original.stop) {
                safe.push({ stop: true });
                break;
            }
            // Continue looking for stop even after the action quota is exhausted.
            if (safe.length >= LIMITS.maxActionsPerReply) continue;

            const step = {};
            const requested = Math.floor(finiteNumber(original.duration, LIMITS.defaultDurationMs));
            const duration = Math.min(
                LIMITS.maxDurationMs,
                Math.max(LIMITS.minDurationMs, requested),
            );

            if (original.vibrate !== undefined && Number.isFinite(Number(original.vibrate))) {
                step.vibrate = clamp(Number(original.vibrate), 0, LIMITS.maxIntensity);
            }
            if (original.suck !== undefined && Number.isFinite(Number(original.suck))) {
                step.suck = clamp(Number(original.suck), 0, LIMITS.maxIntensity);
            }
            if (step.vibrate === undefined && step.suck === undefined) continue;

            step.duration = duration;
            safe.push(step);
        }

        if (safe.length < parsed.length) {
            log(`安全限制：本条回复 ${parsed.length} 个步骤，实际执行 ${safe.length} 个`, 'warn');
        }
        return safe;
    }

    async function runSequence(steps, source = 'AI 回复') {
        const isAISequence = source === 'AI 回复';
        if (isAISequence && !settings.enabled) return;
        if (!connected || !serverReady || !devices.size) {
            log('没有已连接设备，忽略控制序列', 'warn');
            return;
        }
        const safeSteps = applyHardLimits(steps);
        if (!safeSteps.length) return;
        const runId = invalidateRun();
        const deadline = now() + LIMITS.maxRunDurationMs;
        setMode('sequence');
        if (isAISequence) {
            runTimer = setTimeout(() => {
                if (runId === currentRunId) {
                    returnToBaseline('动作序列达到 35 秒，恢复默认 20% 震动');
                }
            }, LIMITS.maxRunDurationMs);
        }
        log(source + '：载入 ' + safeSteps.length + ' 个步骤');
        try {
            do {
                for (const step of safeSteps) {
                    if (runId !== currentRunId || (isAISequence && now() >= deadline)) return;
                    if (step.stop) {
                        await cancelSequence('收到明确停止指令，自动控制已关闭');
                        return;
                    }
                    const end = Math.min(now() + step.duration, deadline);
                    let expired = false;
                    let restPromise = null;
                    const restoreRest = () => {
                        expired = true;
                        restPromise = sendStepToDevices(restStep(), runId).catch(error => {
                            if (runId === currentRunId) return cancelSequence('恢复默认状态失败：' + error.message);
                        });
                    };
                    // Start the timer before sending, so ACK delay cannot extend a step.
                    stepTimer = setTimeout(restoreRest, Math.max(0, end - now()));
                    await sendStepToDevices(
                        { vibrate: 0, suck: 0, ...step },
                        runId,
                        () => !expired && now() < end,
                    );
                    if (runId !== currentRunId) return;
                    await sleep(Math.max(0, end - now()));
                    if (runId !== currentRunId) return;
                    if (!expired) {
                        clearTimeout(stepTimer);
                        restoreRest();
                    }
                    await restPromise;
                    if (runId !== currentRunId) return;
                    await sleep(Math.min(LIMITS.gapBetweenActionsMs, Math.max(0, deadline - now())));
                }
            } while (isAISequence && runId === currentRunId && settings.enabled && now() < deadline);
        } catch (error) {
            if (runId === currentRunId) await cancelSequence('动作发送失败：' + error.message);
        } finally {
            if (runId === currentRunId) {
                if (settings.enabled) await returnToBaseline('动作结束，恢复默认 20% 震动');
                else {
                    invalidateRun();
                    setMode('stopped');
                    await stopAllDevices();
                }
            }
        }
    }

    function getLatestAssistantMessage() {
        if (!getContextFn) return null;
        try {
            const context = getContextFn();
            const chat = context?.chat;
            if (!Array.isArray(chat)) return null;
            for (let index = chat.length - 1; index >= 0; index--) {
                const message = chat[index];
                if (message && message.is_user !== true && message.is_system !== true && typeof message.mes === 'string' && message.mes.trim()) {
                    return { index, chatLength: chat.length, text: message.mes };
                }
            }
        } catch (error) {
            log(`读取聊天消息失败：${error.message}`, 'warn');
        }
        return null;
    }

    async function resolveContext() {
        if (window.getContext) return window.getContext;
        if (window.SillyTavern?.getContext) return window.SillyTavern.getContext;
        const paths = ['../../../../extensions.js', '../../../extensions.js', '../../extensions.js'];
        for (const path of paths) {
            try {
                const module = await import(path);
                if (module.getContext) return module.getContext;
            } catch (_) {}
        }
        return null;
    }

    function scheduleCompletedMessage() {
        if (!generation || generation.cancelled || !generation.ended || !generation.received) return;
        if (getContextFn()?.streamingProcessor?.abortController?.signal?.aborted) {
            generation.cancelled = true;
            return;
        }
        clearTimeout(completionTimer);
        const current = generation;
        completionTimer = setTimeout(() => {
            if (generation !== current || current.cancelled || !settings.enabled) return;
            const context = getContextFn();
            if (context.streamingProcessor?.abortController?.signal?.aborted) return;
            if (context.getCurrentChatId?.() !== current.chatId) return;
            const message = context.chat?.[current.messageId];
            if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return;
            const key = String(current.messageId) + ':' + message.mes;
            if (key === current.beforeKey || key === lastProcessedKey) return;
            current.cancelled = true; // One execution for this completed generation.
            lastProcessedKey = key;
            const parsed = parseToyTags(message.mes);
            if (parsed.length) runSequence(parsed);
        }, 0);
    }

    function attachGenerationEvents() {
        const context = getContextFn?.();
        eventSource = context?.eventSource;
        eventTypes = context?.eventTypes || context?.event_types;
        const required = ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED'];
        generationEventsReady = !!eventSource?.on && required.every(name => eventTypes?.[name]);
        if (!generationEventsReady) {
            log('当前酒馆缺少完整生成事件，自动动作解析不可用', 'warn');
            return;
        }
        eventSource.on(eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
            if (type === 'quiet' || type === 'impersonate' || dryRun) return;
            const latest = getLatestAssistantMessage();
            const context = getContextFn();
            generation = {
                chatId: context.getCurrentChatId?.(),
                beforeKey: latest ? String(latest.index) + ':' + latest.text : '',
                cancelled: !settings.enabled,
                ended: false,
                received: false,
            };
            clearTimeout(completionTimer);
            returnToBaseline('等待 AI 回复，默认震动 20%');
        });
        eventSource.on(eventTypes.MESSAGE_RECEIVED, (messageId, type) => {
            if (!generation || generation.cancelled || type === 'first_message') return;
            generation.messageId = Number(messageId);
            generation.received = true;
            scheduleCompletedMessage();
        });
        eventSource.on(eventTypes.GENERATION_ENDED, () => {
            if (!generation) return;
            generation.ended = true;
            scheduleCompletedMessage();
        });
        eventSource.on(eventTypes.GENERATION_STOPPED, () => cancelSequence('用户停止生成，设备已停止'));
        if (eventTypes.MESSAGE_SENT) {
            eventSource.on(eventTypes.MESSAGE_SENT, () => returnToBaseline('消息已发送，默认震动 20%'));
        }
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, () => {
                generation = null;
                lastProcessedKey = '';
                cancelSequence('切换聊天，设备已停止');
            });
        }
        log('已监听本轮回复完成事件，输入和等待期间保持默认震动');
    }

    async function initialize() {
        loadSettings();
        initUI();
        log(`安全序列控制器 ${PLUGIN_VERSION} 已加载`);
        log(`硬限制：强度≤${Math.round(LIMITS.maxIntensity * 100)}%，单步≤${LIMITS.maxDurationMs}ms，AI 序列循环≤${LIMITS.maxRunDurationMs / 1000}秒，每轮≤${LIMITS.maxActionsPerReply}步`);

        getContextFn = await resolveContext();
        if (!getContextFn) {
            log('无法取得 SillyTavern getContext，AI 自动解析暂不可用', 'error');
        } else {
            attachGenerationEvents();
        }

        if (settings.autoConnect) {
            setTimeout(() => connectToServer().catch(error => log(error.message, 'error')), 1200);
        }
    }

    jQuery(initialize);
})();
