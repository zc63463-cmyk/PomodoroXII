'use client'

/**
 * Setup form (F0 §7.3.1 — RHF + Zod + 409 handling).
 *
 * On success: auth-store setup (setup + login) → redirect /select-space
 * On 409: system already set up → toast + redirect /login
 */

import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { isAxiosError } from 'axios'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const setupSchema = z
  .object({
    password: z.string().min(8, '密码至少 8 位'),
    confirmPassword: z.string().min(8, '密码至少 8 位'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: '两次输入的密码不一致',
    path: ['confirmPassword'],
  })
type SetupFormData = z.infer<typeof setupSchema>

export function SetupForm() {
  const router = useRouter()
  const setup = useAuthStore((s) => s.setup)
  const isAuthenticating = useAuthStore((s) => s.isAuthenticating)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SetupFormData>({
    resolver: zodResolver(setupSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  const onSubmit = async (data: SetupFormData) => {
    try {
      await setup(data.password)
      router.replace('/select-space')
    } catch (e) {
      // 409 = backend already set up → prompt login
      if (isAxiosError(e) && e.response?.status === 409) {
        toast.error('已初始化', {
          description: '系统已设置密码，请直接登录',
        })
        router.replace('/login')
        return
      }
      toast.error('设置失败', { description: (e as Error).message })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>首次设置</CardTitle>
        <CardDescription>设置管理员密码以开始使用</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">密码</Label>
            <Input id="password" type="password" {...register('password')} />
            {errors.password ? (
              <p className="text-sm text-destructive">
                {errors.password.message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword">确认密码</Label>
            <Input
              id="confirmPassword"
              type="password"
              {...register('confirmPassword')}
            />
            {errors.confirmPassword ? (
              <p className="text-sm text-destructive">
                {errors.confirmPassword.message}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={isAuthenticating}>
            {isAuthenticating ? '设置中…' : '完成设置'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
