'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface GlassConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  variant?: 'confirm' | 'alert';
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
}

export function GlassConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  variant = 'confirm',
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
}: GlassConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="rounded-[22px] border border-white/60 bg-white/72 p-0 shadow-[0_24px_72px_rgba(15,23,42,0.16)] backdrop-blur-2xl sm:max-w-[400px]"
      >
        <AlertDialogHeader className="px-6 pt-6 pb-4 text-center sm:text-center">
          <AlertDialogTitle className="text-lg font-extrabold text-slate-800">
            {title}
          </AlertDialogTitle>
          {description && (
            <AlertDialogDescription className="mt-2 text-sm leading-relaxed text-slate-500">
              {description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter className="px-6 pb-6 gap-3 sm:justify-center">
          {variant === 'confirm' && (
            <AlertDialogCancel
              className="h-10 min-w-[100px] rounded-full border-slate-200/80 bg-white/70 text-sm font-semibold text-slate-500 shadow-none backdrop-blur-md hover:bg-white/90 hover:text-slate-700"
            >
              {cancelText}
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            onClick={onConfirm}
            className="h-10 min-w-[100px] rounded-full bg-gradient-to-br from-slate-700 to-slate-800 text-sm font-semibold text-white shadow-[0_8px_22px_rgba(15,23,42,0.18)] hover:from-slate-800 hover:to-slate-900"
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
