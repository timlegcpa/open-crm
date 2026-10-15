import { Moon, Sun } from 'lucide-react';
import { Panel } from '@/components/layout/page';
import { Segmented } from '@/components/ui/segmented';
import { useThemeControls } from '@/hooks/useTheme';

/** Light or dark for this browser. The choice is kept in this browser only. */
export function AppearanceSection() {
  const controls = useThemeControls();
  const value = controls?.isDark ? 'dark' : 'light';

  return (
    <Panel title="Appearance" bodyClassName="flex flex-col gap-3 p-4">
      <p className="text-[13px] text-muted-foreground">Remembered in this browser. Other browsers keep their own choice.</p>
      {controls ? (
        <Segmented
          label="Theme"
          value={value}
          onValueChange={(next) => {
            if (next !== value) controls.toggle();
          }}
          options={[
            { value: 'light', label: (<><Sun />Light</>) },
            { value: 'dark', label: (<><Moon />Dark</>) },
          ]}
        />
      ) : (
        <p className="text-[13px]">The theme can be changed inside the app.</p>
      )}
    </Panel>
  );
}
