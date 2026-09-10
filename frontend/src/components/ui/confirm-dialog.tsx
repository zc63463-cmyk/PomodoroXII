'use client'

/**
 * 通用二次确认对话框。
 *
 * ★ 为什么替换 window.confirm
 *   1. 原生弹窗样式完全不受控，跟产品设计割裂（此前删文件夹用的就是它）
 *   2. 按钮只能是"确定/取消"，说不清到底要做什么
 *   3. 阻塞主线程，也没有无障碍标记
 *
 * ★ 焦点默认落在「取消」
 *   Dialog 打开时焦点会落在第一个可聚焦元素上，所以**取消按钮必须排在前面**。
 *   这样即使用户习惯性连按回车，也不会误删。
 *
 * ★ 按钮文案要能独立表意
 *   写"删除笔记"而不是"确定" —— 用户扫一眼就知道点下去会发生什么。
 */

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 说明这次操作会发生什么、是否可恢复。 */
  description: string
  confirmLabel?: string
  cancelLabel?: string
  /** 破坏性操作时确认按钮用红色。 */
  destructive?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {/* ★ 取消在前：承接 Dialog 打开时的默认焦点 */}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
