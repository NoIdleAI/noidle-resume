import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('../pages/Dashboard.vue') },
    { path: '/sessions', name: 'sessions', component: () => import('../pages/SessionsPage.vue') },
    { path: '/tasks/:id', name: 'task', component: () => import('../pages/TaskDetailPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('../pages/SettingsPage.vue') },
    { path: '/about', name: 'about', component: () => import('../pages/AboutPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
