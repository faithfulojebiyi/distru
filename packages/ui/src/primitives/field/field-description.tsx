import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const fieldDescriptionStyles = cva({
  base: {
    '.group\\/field[data-orientation=horizontal] &': {
      textWrap: 'balance',
    },
    '[data-variant=legend]+&': {
      mt: '-1.5',
    },
    '& > a': {
      _hover: {
        color: 'brand.primary',
      },
      textDecoration: 'underline',
      textUnderlineOffset: '4',
    },
    '&:last-child': {
      mt: '0',
    },
    '&:nth-last-child(2)': {
      mt: '-1',
    },
    color: 'text.muted',
    fontSize: '1',
    fontWeight: 'normal',
    lineHeight: 'normal',
  },
});

const StyledFieldDescription = styled('p', fieldDescriptionStyles);

export const FieldDescription = ({
  ...props
}: React.ComponentProps<'p'> & JsxStyleProps) => {
  return <StyledFieldDescription data-slot="field-description" {...props} />;
};
