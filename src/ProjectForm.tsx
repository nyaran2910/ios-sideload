import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from "@raycast/api";
import { shortenHome } from "./env";
import { clearProjectOverride, saveProjectOverride } from "./storage";
import type { DetectedProject, ProjectOverride, RunMode } from "./types";

interface ProjectFormProps {
  project: DetectedProject;
  override?: ProjectOverride;
  onSaved: () => void;
}

interface FormValues {
  enabled: boolean;
  mode: RunMode | "inherit";
  name: string;
  appPath: string;
  buildCommand: string;
  installCommand: string;
  sourcePaths: string;
  bundleId: string;
}

export function ProjectForm({ project, override, onSaved }: ProjectFormProps) {
  const { pop } = useNavigation();

  async function handleSubmit(values: FormValues) {
    await saveProjectOverride({
      dir: project.dir,
      enabled: values.enabled,
      mode: values.mode,
      name: values.name.trim() || undefined,
      appPath: values.appPath.trim() || undefined,
      buildCommand: values.buildCommand.trim() || undefined,
      installCommand: values.installCommand.trim() || undefined,
      sourcePaths: values.sourcePaths.trim() || undefined,
      bundleId: values.bundleId.trim() || undefined,
    });
    onSaved();
    pop();
    await showToast({ style: Toast.Style.Success, title: `Saved ${values.name.trim() || project.name}` });
  }

  async function handleReset() {
    await clearProjectOverride(project.dir);
    onSaved();
    pop();
    await showToast({ style: Toast.Style.Success, title: `Reset ${project.name} to Defaults` });
  }

  return (
    <Form
      navigationTitle={`Configure ${project.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Project Settings" icon={Icon.Check} onSubmit={handleSubmit} />
          <Action title="Reset to Auto-Detected Defaults" icon={Icon.RotateAntiClockwise} onAction={handleReset} />
        </ActionPanel>
      }
    >
      <Form.Description title="Directory" text={`${shortenHome(project.dir)} (${project.kind})`} />
      <Form.Checkbox
        id="enabled"
        title="Include in Run"
        label="Enable this project when running Renew iOS Sideloads"
        defaultValue={override?.enabled ?? project.enabled}
      />
      <Form.Dropdown
        id="mode"
        title="Build / Update Mode"
        defaultValue={override?.mode ?? project.modeOverride}
      >
        <Form.Dropdown.Item value="inherit" title="Use Global Extension Setting" />
        <Form.Dropdown.Item value="auto" title="Auto (Makefile: Build if changed, else Install)" />
        <Form.Dropdown.Item value="install" title="Update Only (Install existing .app)" />
        <Form.Dropdown.Item value="build" title="Force Rebuild & Install" />
      </Form.Dropdown>
      <Form.Separator />
      <Form.TextField
        id="name"
        title="Display Name"
        placeholder={project.name}
        defaultValue={override?.name ?? ""}
      />
      <Form.TextField
        id="appPath"
        title=".app Bundle Path"
        placeholder={project.appPath ? shortenHome(project.appPath) : "Optional override path to .app"}
        defaultValue={override?.appPath ?? ""}
      />
      <Form.TextField
        id="bundleId"
        title="Bundle Identifier"
        placeholder={project.bundleId ?? "Used for Launch After Install"}
        defaultValue={override?.bundleId ?? ""}
      />
      <Form.TextField
        id="sourcePaths"
        title="Watched Source Paths"
        placeholder="Optional semicolon-separated relative paths (e.g. Sources; project.yml)"
        defaultValue={override?.sourcePaths ?? ""}
      />
      <Form.Separator />
      <Form.TextField
        id="buildCommand"
        title="Custom Build Command"
        placeholder="Optional shell command (leave blank for auto-detected xcodebuild/tauri)"
        defaultValue={override?.buildCommand ?? ""}
      />
      <Form.TextField
        id="installCommand"
        title="Custom Install Command"
        placeholder="Optional shell command (uses $DEVICE_ID, $TEAM_ID, $APP_PATH)"
        defaultValue={override?.installCommand ?? ""}
      />
    </Form>
  );
}
