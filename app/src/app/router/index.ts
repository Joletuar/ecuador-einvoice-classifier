import { createRouter, createWebHistory, type RouterHistory } from 'vue-router'

import { RouteName } from './routeNames'
import AppLayout from '../layouts/AppLayout.vue'
import InvoicesPage from '../../features/invoices/pages/InvoicesPage.vue'
import UploadPage from '../../features/upload/pages/UploadPage.vue'
import InformationPage from '../../features/information/pages/InformationPage.vue'

export function createAppRouter(
  history: RouterHistory = createWebHistory(import.meta.env.BASE_URL),
) {
  const positions = new Map<
    string,
    {
      left: number
      top: number
    }
  >()
  const router = createRouter({
    history,
    routes: [
      {
        path: '/',
        component: AppLayout,
        children: [
          { path: '', redirect: { name: RouteName.Upload } },
          {
            path: 'invoices/upload',
            name: RouteName.Upload,
            component: UploadPage,
          },
          {
            path: 'invoices',
            name: RouteName.Invoices,
            component: InvoicesPage,
          },
          {
            path: 'information',
            name: RouteName.Information,
            component: InformationPage,
          },
        ],
      },
      { path: '/:pathMatch(.*)*', redirect: { name: RouteName.Upload } },
    ],

    scrollBehavior(to, _from, savedPosition) {
      return savedPosition ?? positions.get(to.path) ?? { left: 0, top: 0 }
    },
  })

  router.beforeEach((_to, from) => {
    if (typeof window !== 'undefined') {
      positions.set(from.path, { left: window.scrollX, top: window.scrollY })
    }
  })

  return router
}
