import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router/index';
import { initAuth } from './stores/data';
import { startTicker } from './stores/ticker';
import './styles/tokens.css';

startTicker();
void initAuth();

createApp(App).use(router).mount('#app');
