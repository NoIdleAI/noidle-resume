<script setup lang="ts">
import { computed } from 'vue';

/** 与 package.json / tauri.conf.json 同步（发版时三处一起改） */
const VERSION = '0.1.1';

const dataDir = computed(() => {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return '%APPDATA%\\noidle-resume';
  if (ua.includes('Mac')) return '~/Library/Application Support/noidle-resume';
  return '~/.local/share/noidle-resume';
});

const features = [
  ['自动续跑', '撞限转写 api_error 帧实时检测，重置时刻一到自动以 headless CLI 续跑会话，全程零人工'],
  ['转写为事实源', '结算只认转写落盘并过血统核验；续跑进程超时、被杀甚至不退场，都不影响判定'],
  ['值守台', '总览 / 会话 / 任务详情六问 / 设置与日志四页；登记会话自动扫描转写根，免手抠 UUID'],
  ['零额度测试', '单元 + 集成 + 真浏览器 E2E 全部走假引擎演练，测试不烧一分钟真额度'],
];

const security = [
  '全部数据只存本机数据目录，无任何遥测与上报',
  '服务仅监听 127.0.0.1，令牌门 + HttpOnly Cookie 鉴权',
  '恢复引擎显式 --permission-mode default，绝不使用危险模式',
  '对外仅访问本机转写目录与你配置的模型 CLI，不经第三方服务器',
];
</script>

<template>
  <div class="about">
    <div class="head hero">
      <div class="logo"><span class="mark">N</span></div>
      <div class="head-txt">
        <h1>NoIdle Resume</h1>
        <p class="tagline">GLM Coding Plan 限额到点后，自动续跑 VS Code 侧边栏 Claude Code 会话的本地工具</p>
        <p class="meta mono">v{{ VERSION }} · Apache-2.0 · 本地值守 · 转写事实源 · 自动重发</p>
      </div>
    </div>

    <div class="grid2">
      <div class="subcard">
        <h4>功能亮点</h4>
        <div class="feat" v-for="[t, d] in features" :key="t">
          <b>{{ t }}</b>
          <span>{{ d }}</span>
        </div>
      </div>

      <div class="col">
        <div class="subcard">
          <h4>本地与安全</h4>
          <ul class="sec-list">
            <li v-for="s in security" :key="s">{{ s }}</li>
          </ul>
        </div>
        <div class="subcard">
          <h4>数据与隐私</h4>
          <div class="kv">
            <span class="k">数据目录</span><span class="v">{{ dataDir }}</span>
            <span class="k">技术栈</span><span class="v">Tauri v2 · Vue 3 · Fastify · SQLite</span>
            <span class="k">开源</span><span class="v">github.com/NoIdleAI/noidle-resume</span>
          </div>
        </div>
        <div class="subcard">
          <h4>声明</h4>
          <p class="reading">本项目为独立的本地效率工具，与 Anthropic（Claude）及 GLM 服务提供方<b>无隶属关系</b>，亦非其官方客户端。限额策略与重置规则以服务商实际策略为准，本项目仅按转写中的事件做本地自动化。使用前请遵守你所使用模型服务的用户条款。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about { display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; gap: 18px; align-items: center; padding: 22px 24px; }
.logo .mark {
  display: grid; place-items: center;
  width: 54px; height: 54px; border-radius: 14px;
  background: var(--acc); color: #17130f; font-size: 30px; font-weight: 800;
}
.head-txt h1 { font-size: 19px; font-weight: 700; }
.tagline { font-size: 13px; color: var(--tx-2); margin-top: 3px; }
.meta { font-size: 11px; color: var(--tx-3); margin-top: 6px; }
.grid2 { display: grid; grid-template-columns: 1.1fr 1fr; gap: 14px; align-items: start; }
.col { display: flex; flex-direction: column; }
.feat { display: flex; flex-direction: column; gap: 2px; padding: 7px 0; border-bottom: 1px dashed var(--line); }
.feat:last-child { border-bottom: none; padding-bottom: 0; }
.feat b { font-size: 12.5px; color: var(--tx); font-weight: 650; }
.feat span { font-size: 12px; color: var(--tx-2); line-height: 1.7; }
.sec-list { list-style: none; }
.sec-list li { font-size: 12px; color: var(--tx-2); line-height: 2; padding-left: 14px; position: relative; }
.sec-list li::before { content: ""; position: absolute; left: 0; top: 11px; width: 5px; height: 5px; border-radius: 50%; background: var(--acc); }
@media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } }
</style>
