import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const fieldTitleStyles = cva({
  base: {
    '.group\\/field[data-disabled=true] &': {
      opacity: '0.5',
    },
    alignItems: 'center',
    display: 'flex',
    fontSize: '2',
    fontWeight: '500',
    gap: '2',
    lineHeight: 'tight',
    w: 'fit-content',
  },
});

const StyledFieldTitle = styled('div', fieldTitleStyles);

export const FieldTitle = ({
  ...props
}: React.ComponentProps<'div'> & JsxStyleProps) => {
  return <StyledFieldTitle data-slot="field-label" {...props} />;
};
