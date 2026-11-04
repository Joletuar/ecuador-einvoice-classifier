import { watch } from 'vue'
import type { Router, RouteLocationNormalized } from 'vue-router'

import { RouteName } from './routeNames'
import { InvoiceSnapshotKind } from '../../features/invoices/domain/invoiceSnapshot'
import type { useInvoiceStore } from '../../features/invoices/stores/useInvoiceStore'
import type { LeaveProtection } from '../navigation/leaveProtection'

type InvoiceStore = ReturnType<typeof useInvoiceStore>

export function installNavigationGuards(
  router: Router,
  invoices: InvoiceStore,
  protection: LeaveProtection,
) {
  const decisions = new WeakMap<
    RouteLocationNormalized,
    Awaited<ReturnType<LeaveProtection['prepareLeave']>>
  >()

  const before = router.beforeEach(async (to, from) => {
    if (to.name === RouteName.Invoices) {
      await invoices.initialize()

      if (
        invoices.snapshot.kind === InvoiceSnapshotKind.Ready &&
        !invoices.hasInvoices
      ) {
        return { name: RouteName.Upload, replace: true }
      }
    }

    if (from.name && to.name !== from.name) {
      const decision = await protection.prepareLeave()

      if (!decision.allowed) {
        return false
      }

      decisions.set(to, decision)
    }
  })

  const after = router.afterEach((to, _from, failure) => {
    const decision = decisions.get(to)

    if (failure) {
      decision?.cancel()
    } else {
      decision?.commit()
    }

    decisions.delete(to)
  })

  const onError = router.onError((_error, to) => {
    decisions.get(to)?.cancel()
    decisions.delete(to)
  })

  const stop = watch(
    () =>
      invoices.snapshot.kind === InvoiceSnapshotKind.Ready &&
      !invoices.hasInvoices,
    (empty) => {
      if (empty && router.currentRoute.value.name === RouteName.Invoices) {
        void router.replace({ name: RouteName.Upload })
      }
    },
  )

  return () => {
    before()
    after()
    onError()
    stop()
  }
}
