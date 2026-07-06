'use client'

/**
 * Login form (F0 §7.3.1 — RHF + Zod).
 *
 * On success: redirect to /select-space
 * On failure: toast error
 */

import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
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

const loginSchema = z.object({
  password: z.string().min(1, '请输入密码'),
})
type LoginFormData = z.infer<typeof loginSchema>

export function LoginForm() {
  const router = useRouter()
  const login = useAuthStore((s) => s.login)
  const isAuthenticating = useAuthStore((s) => s.isAuthenticating)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { password: '' },
  })

  const onSubmit = async (data: LoginFormData) => {
    try {
      await login(data.password)
      router.replace('/select-space')
    } catch (e) {
      toast.error('登录失败', { description: (e as Error).message })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>登录</CardTitle>
        <CardDescription>输入密码以继续</CardDescription>
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
          <Button type="submit" disabled={isAuthenticating}>
            {isAuthenticating ? '登录中…' : '登录'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
