// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Divider, Flex, Stack, Tabs, VerticalNav } from '@nvidia/foundations-react-core'

export type ResponsiveNavItem = {
    id: string
    label: string
}

interface ResponsiveNavLayoutProps {
    /** Switch to horizontal tabs when the container is narrower than this (px). Default 600. */
    minWidth?: number
    activeId: string
    onActiveChange: (id: string) => void
    items: ResponsiveNavItem[]
    /** Extra classes on wide-mode `VerticalNav` (e.g. `slim-vertical-nav`, `settings-nav`). */
    verticalNavClassName?: string
    /** When true, wide mode renders a `Divider` above the `VerticalNav` (ignored in tab mode). */
    showDividerOnVertical?: boolean
    className?: string
    children: ReactNode
}

/**
 * Observes container width: at or above `minWidth` shows a left `VerticalNav`; below that shows top `Tabs`.
 *
 * `children` always mount under the same parent `Flex` (second slot). Only the nav chrome swaps
 * (`VerticalNav` vs trigger-only `Tabs`), so in-flight UI (modals, forms) survives breakpoint changes.
 */
export function ResponsiveNavLayout({
    minWidth = 640,
    activeId,
    onActiveChange,
    items,
    verticalNavClassName,
    showDividerOnVertical,
    className,
    children
}: ResponsiveNavLayoutProps) {
    const ref = useRef<HTMLDivElement>(null)
    const [width, setWidth] = useState<number | null>(null)

    useEffect(() => {
        const el = ref.current
        if (!el) return

        const ro = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width
            if (w !== undefined) setWidth(w)
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    const useWideNav = width === null || width >= minWidth

    // These items switch views in place (activeId/onActiveChange) rather than navigating to a
    // URL, so per the library's own guidance they render via `asChild` onto a real `<button>`
    // instead of the default `<a href>` — keyboard/AT users get a button, not a dead link.
    // `href` is still required by VerticalNavBaseLeafItem's type even though asChild means it's
    // never actually rendered.
    const verticalNavItems = useMemo(
        () =>
            items.map(item => ({
                id: item.id,
                href: `#${item.id}`,
                asChild: true,
                children: (
                    <button type="button" onClick={() => onActiveChange(item.id)}>
                        {item.label}
                    </button>
                ),
                active: activeId === item.id
            })),
        [items, activeId, onActiveChange]
    )

    const tabsItems = useMemo(
        () =>
            items.map(item => ({
                value: item.id,
                children: item.label
            })),
        [items]
    )

    const navClass = `no-bg-nav relative shrink-0${verticalNavClassName ? ` ${verticalNavClassName}` : ''}`

    return (
        <Stack
            className="responsive-nav-layout flex-1 min-h-0 w-full grow relative overflow-hidden"
            align="start"
            justify="start"
            gap="0"
        >
            {showDividerOnVertical && useWideNav && (
                <Divider className="max-h-px relative opacity-75" />
            )}
            <Flex
                ref={ref}
                gap={useWideNav ? '4' : '0'}
                direction={useWideNav ? 'row' : 'col'}
                className={`flex-1 min-h-0 w-full grow relative overflow-hidden${useWideNav ? ' responsive-nav-layout-wide' : ''}${className ? ` ${className}` : ''}`}
            >
                {useWideNav ? (
                    <VerticalNav className={navClass} items={verticalNavItems} />
                ) : (
                    <Tabs
                        value={activeId}
                        onValueChange={value => onActiveChange(String(value))}
                        className="shrink-0 w-full min-w-0 no-px-tabs-content"
                        items={tabsItems}
                    />
                )}
                <div
                    className={`responsive-nav-content flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col${useWideNav ? ' responsive-nav-content-wide' : ''}`}
                >
                    {children}
                </div>
            </Flex>
        </Stack>
    )
}
