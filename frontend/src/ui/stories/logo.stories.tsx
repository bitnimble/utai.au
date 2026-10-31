import type { Meta, StoryObj } from '@storybook/react-vite';
import { Logo } from 'src/ui/logo/logo';
import { Gallery, Variant } from 'src/ui/stories/_variants';

const meta: Meta = {
  title: 'Components/Logo',
};
export default meta;

type Story = StoryObj;

/** The logo at the sizes it's used, in one place. */
export const All: Story = {
  render: () => (
    <Gallery>
      <Variant label="Launch pages (360)">
        <Logo />
      </Variant>
      <Variant label="Small (180)">
        <Logo width={180} />
      </Variant>
    </Gallery>
  ),
};
